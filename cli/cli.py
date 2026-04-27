"""
BioBot CLI — terminal interface sharing the same database as the web UI.

This file lives in cli/ and imports directly from biobot/.
No files in biobot/ are modified.

Usage:
    # Interactive (with login + chat history)
    biobot                              # default = chat : Start interactive chat
    biobot chat                         # same
    biobot chat --new                   # skip chat picker
    biobot chat -f source.csv -f dest.csv   # attach files to first message

    # One-shot (no login, no clarification, no history)
    biobot ask "Generate an OT-2 serial dilution protocol"
    biobot ask "..." -o response.md     # save to file

    # Plate transfer generator (existing)
    biobot generate source.csv dest.csv -o instructions.csv

    # Web UI (opens browser)
    biobot web
    biobot web --url http://192.168.1.10:5000

    # Auxiliary
    biobot register            Create a new account
    biobot init-db             Initialize database tables
    biobot list                List your saved chats   
    
    # Commands while in chat
    /new                       Start a new chat
    /list                      List saved chats
    /switch N                  Switch to chat #N
    /save                      Save last code to file
    /delete N                  Delete chat #N
    /upload <path>             Attach file(s) to your next message
    /files                     List currently attached files
    /clear-files               Clear attached files without sending
    /quit                      Exit
"""

# ── Bootstrap: resolve paths and load env BEFORE any project imports ──
import os
import sys
from pathlib import Path

# Resolve project directories
CLI_DIR = Path(__file__).resolve().parent          # cli/
PROJECT_DIR = CLI_DIR.parent                        # project root
BIOBOT_DIR = PROJECT_DIR / "biobot"                 # biobot/

# Load .env from project root (same file Docker uses)
try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_DIR / ".env")
except ImportError:
    pass  # python-dotenv not installed, rely on exported env vars

# If DB_HOST is "postgres" (Docker internal name), swap to localhost
# since the CLI runs outside Docker
if os.environ.get("DB_HOST") == "postgres":
    os.environ["DB_HOST"] = "localhost"

# Also support DB_PASSWORD as DB_PASS (docker-compose uses DB_PASSWORD)
if not os.environ.get("DB_PASS") and os.environ.get("DB_PASSWORD"):
    os.environ["DB_PASS"] = os.environ["DB_PASSWORD"]

# Add biobot/ to Python path so we can import config, engine, etc.
sys.path.insert(0, str(BIOBOT_DIR))

# Change working directory to biobot/ so engine.py's subprocess
# ("python3 main_rag.py") and main_rag.py's SCRIPT_DIR both work
os.chdir(BIOBOT_DIR)

# ── Now safe to import from biobot/ ──────────────────────────
import argparse
import getpass
import re
import uuid
from datetime import datetime

import psycopg2
import psycopg2.extras
from werkzeug.security import check_password_hash, generate_password_hash

from biobot.config import get_db_connection, get_api_key, init_db, wait_for_postgres
from biobot.engine import process_user_query, RAG_STATUS_PREFIX, FAILED_CODE_MARKER

try:
    from crypt import generate_salt, derive_key, encrypt, decrypt
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

__version__ = "0.1.0"


# ── ANSI colors ──────────────────────────────────────────────

class C:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    GREEN = "\033[38;2;0;255;153m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"

def _c(text, color):
    return f"{color}{text}{C.RESET}" if sys.stdout.isatty() else text


def _ask(prompt, allow_empty=False, password=False):
    """
    Prompt for input. At ANY prompt, the user can type:
      q / quit / exit  → exits the program
      Ctrl+C           → exits the program
    Returns the stripped input, or None if empty and allow_empty=False.
    """
    try:
        if password:
            value = getpass.getpass(prompt)
        else:
            value = input(prompt).strip()
    except (KeyboardInterrupt, EOFError):
        print(_c("\n\n  Goodbye!\n", C.GREEN))
        sys.exit(0)

    if value.lower() in ("q", "quit", "exit"):
        print(_c("\n  Goodbye!\n", C.GREEN))
        sys.exit(0)

    if not value and not allow_empty:
        return None

    return value


# ── DB helpers ───────────────────────────────────────────────

def _fetchone(conn, query, params=()):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(query, params)
    row = cur.fetchone()
    cur.close()
    return row

def _fetchall(conn, query, params=()):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(query, params)
    rows = cur.fetchall()
    cur.close()
    return rows

def _execute(conn, query, params=(), commit=False):
    cur = conn.cursor()
    cur.execute(query, params)
    if commit:
        conn.commit()
    cur.close()


# ── Session (holds logged-in user state) ─────────────────────

class Session:
    def __init__(self, user_id, api_key, enc_key=None):
        self.user_id = user_id
        self.api_key = api_key
        self.enc_key = enc_key

    def encrypt(self, text):
        if self.enc_key and HAS_CRYPTO and text:
            return encrypt(text, self.enc_key)
        return text

    def decrypt(self, ciphertext):
        if self.enc_key and HAS_CRYPTO and ciphertext:
            try:
                return decrypt(ciphertext, self.enc_key)
            except Exception:
                return ciphertext
        return ciphertext


# ── Auth ─────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "You are BioBot 🤖, an expert assistant specialized in lab automation, "
    "particularly with liquid handling robots.\nYour tasks:\n"
    "- Focus on the **latest user message**. Use history only for reference.\n"
    "- Generate clean, error-free Python code for operating lab robots.\n"
    "- Ask for more info if needed.\n"
    "- Decline unrelated requests kindly."
)


def login_prompt() -> Session:
    """Prompt for email/password and authenticate against the DB."""
    print()
    print(_c("  ── BioBot Login ──", C.GREEN))
    print(_c("  Type 'register' to create an account, 'q' to quit.", C.DIM))
    print()

    while True:
        email = _ask(_c("  Email: ", C.WHITE))
        if not email:
            continue

        if email.lower() == "register":
            register_prompt()
            print(_c("  Now log in with your new account:\n", C.DIM))
            continue

        password = _ask(_c("  Password: ", C.WHITE), password=True)
        if not password:
            continue

        conn = get_db_connection()
        try:
            user = _fetchone(conn, "SELECT * FROM users WHERE email = %s", (email,))
        finally:
            conn.close()

        if not user:
            print(_c("  No account found with this email.\n", C.RED))
            continue

        if not check_password_hash(user["password"], password):
            print(_c("  Incorrect password.\n", C.RED))
            continue

        # Success
        enc_key = None
        if HAS_CRYPTO and user.get("encryption_salt"):
            enc_key = derive_key(password, user["encryption_salt"])

        raw_api_key = user.get("api_key", "")
        if enc_key and raw_api_key:
            try:
                raw_api_key = decrypt(raw_api_key, enc_key)
            except Exception:
                pass

        api_key = raw_api_key or get_api_key()

        print(_c(f"\n  Welcome back, {user['first_name']}!\n", C.GREEN + C.BOLD))
        return Session(user["id"], api_key, enc_key)


def register_prompt():
    """Create a new account (same fields as web UI register page)."""
    print()
    print(_c("  ── BioBot Sign-up ──", C.GREEN))
    print(_c("  Type 'q' at any prompt to quit.", C.DIM))
    print()

    first_name = _ask(_c("  First Name: ", C.WHITE))
    if not first_name:
        print(_c("  First name is required.", C.RED))
        return

    last_name = _ask(_c("  Last Name: ", C.WHITE))
    if not last_name:
        print(_c("  Last name is required.", C.RED))
        return

    email = _ask(_c("  Email: ", C.WHITE))
    if not email or "@" not in email:
        print(_c("  Valid email is required.", C.RED))
        return

    password = _ask(_c("  Password: ", C.WHITE), password=True)
    if not password:
        print(_c("  Password is required.", C.RED))
        return
    password_confirm = _ask(_c("  Confirm password: ", C.WHITE), password=True)
    if password != password_confirm:
        print(_c("  Passwords don't match.", C.RED))
        return

    api_key = _ask(_c("  API Key (leave empty for default): ", C.WHITE), allow_empty=True) or ""

    # Role — same options as web UI
    print()
    print(_c("  Role:", C.WHITE))
    print(f"    {_c('1.', C.CYAN)} Academic")
    print(f"    {_c('2.', C.CYAN)} Professional")
    print(f"    {_c('3.', C.CYAN)} Personal")
    role_choice = _ask(_c("  Select role (1-3): ", C.WHITE)) or "3"
    role_map = {"1": "Chercheur", "2": "Ingénieur", "3": "Particulier"}
    role = role_map.get(role_choice, "Particulier")

    country = _ask(_c("  Country: ", C.WHITE))
    if not country:
        print(_c("  Country is required.", C.RED))
        return

    # Hash & encrypt (same logic as app.py register route)
    hashed_password = generate_password_hash(password)
    final_api_key = api_key or get_api_key()

    salt = None
    encrypted_api_key = final_api_key
    if HAS_CRYPTO:
        salt = generate_salt()
        enc_key = derive_key(password, salt)
        encrypted_api_key = encrypt(final_api_key, enc_key)

    conn = None
    try:
        conn = get_db_connection()
        _execute(conn,
            """
            INSERT INTO users (first_name, last_name, email, password, api_key, role, country, encryption_salt, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (first_name, last_name, email, hashed_password, encrypted_api_key,
             role, country, salt, datetime.now().isoformat()),
            commit=True)
        print(_c(f"\n  Account created for {first_name} {last_name}!", C.GREEN + C.BOLD))
        print(_c("  You can now log in with: biobot\n", C.DIM))
    except Exception as e:
        if conn:
            conn.rollback()
        err_msg = str(e)
        if "unique" in err_msg.lower() or "duplicate" in err_msg.lower():
            print(_c("  This email is already registered.", C.RED))
        else:
            print(_c(f"  Registration error: {e}", C.RED))
    finally:
        if conn:
            conn.close()


# ── Chat operations (same DB tables as web app) ─────────────

def list_user_chats(session: Session) -> list:
    conn = get_db_connection()
    try:
        rows = _fetchall(conn,
            "SELECT chat_id, name FROM chat_names WHERE user_id = %s",
            (session.user_id,))
    finally:
        conn.close()
    return [{"chat_id": r["chat_id"], "name": session.decrypt(r["name"])} for r in rows]


def create_new_chat(session: Session) -> str:
    chat_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    conn = get_db_connection()
    try:
        _execute(conn,
            "INSERT INTO chat_names (chat_id, user_id, name) VALUES (%s, %s, %s)",
            (chat_id, session.user_id, session.encrypt("New chat")),
            commit=True)
        _execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (%s, %s, %s, %s, %s)",
            (session.user_id, chat_id, "system", session.encrypt(SYSTEM_PROMPT), now),
            commit=True)
        _execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (%s, %s, %s, %s, %s)",
            (session.user_id, chat_id, "assistant",
             session.encrypt("Hello, I'm Biobot 🤖 — your assistant specialized in lab automation..."),
             now),
            commit=True)
    finally:
        conn.close()
    return chat_id


def get_chat_history(session: Session, chat_id: str) -> list:
    conn = get_db_connection()
    try:
        rows = _fetchall(conn,
            "SELECT role, content FROM chat_history WHERE user_id = %s AND chat_id = %s ORDER BY created_at",
            (session.user_id, chat_id))
    finally:
        conn.close()
    return [{"role": r["role"], "content": session.decrypt(r["content"])} for r in rows]


def save_message(session: Session, chat_id: str, role: str, content: str):
    conn = get_db_connection()
    try:
        _execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (%s, %s, %s, %s, %s)",
            (session.user_id, chat_id, role, session.encrypt(content), datetime.now().isoformat()),
            commit=True)
    finally:
        conn.close()


def auto_rename_chat(session: Session, chat_id: str, first_message: str):
    conn = get_db_connection()
    try:
        row = _fetchone(conn,
            "SELECT name FROM chat_names WHERE chat_id = %s AND user_id = %s",
            (chat_id, session.user_id))
        if row and session.decrypt(row["name"]) == "New chat":
            words = first_message.strip().split()
            preview = " ".join(words[:5]) + ("..." if len(words) > 5 else "")
            _execute(conn,
                "UPDATE chat_names SET name = %s WHERE chat_id = %s AND user_id = %s",
                (session.encrypt(preview), chat_id, session.user_id),
                commit=True)
    finally:
        conn.close()


def delete_chat_db(session: Session, chat_id: str):
    conn = get_db_connection()
    try:
        _execute(conn, "DELETE FROM chat_history WHERE chat_id = %s AND user_id = %s",
                 (chat_id, session.user_id), commit=True)
        _execute(conn, "DELETE FROM chat_names WHERE chat_id = %s AND user_id = %s",
                 (chat_id, session.user_id), commit=True)
    finally:
        conn.close()


# ── Terminal display ─────────────────────────────────────────

def _banner():
    print()
    print(_c("  ╔══════════════════════════════════════════╗", C.GREEN))
    print(_c("  ║", C.GREEN) + _c("        🧬 BioBot CLI v" + __version__, C.BOLD + C.GREEN) + _c("              ║", C.GREEN))
    print(_c("  ║", C.GREEN) + _c("      Lab Automation Code Generator", C.DIM + C.WHITE) + _c("       ║", C.GREEN))
    print(_c("  ╚══════════════════════════════════════════╝", C.GREEN))
    print()
    print(_c("  Commands:", C.DIM))
    print(f"    {_c('/new', C.CYAN)}             start a new chat")
    print(f"    {_c('/list', C.CYAN)}            list saved chats")
    print(f"    {_c('/switch N', C.CYAN)}        switch to chat #N")
    print(f"    {_c('/upload <path>', C.CYAN)}   attach file(s) to next message")
    print(f"    {_c('/files', C.CYAN)}           show attached files")
    print(f"    {_c('/clear-files', C.CYAN)}     clear attached files")
    print(f"    {_c('/save', C.CYAN)}            save last code to file")
    print(f"    {_c('/delete N', C.CYAN)}        delete chat #N")
    print(f"    {_c('/quit', C.CYAN)}            exit")
    print()


def _print_status(text):
    if sys.stdout.isatty():
        sys.stdout.write(f"\r  {C.DIM}⏳ {text}{C.RESET}\033[K")
        sys.stdout.flush()
    else:
        print(f"  [{text}]")

def _clear_status():
    if sys.stdout.isatty():
        sys.stdout.write("\r\033[K")
        sys.stdout.flush()

def _print_code(code):
    print(_c("  ┌─ python ─────────────────────────────────", C.DIM))
    for line in code.split("\n"):
        print(_c("  │ ", C.DIM) + _c(line, C.GREEN))
    print(_c("  └────────────────────────────────────────────", C.DIM))


def _looks_like_code(text):
    lines = text.strip().split("\n")
    if not lines:
        return False
    indicators = ("import ", "from ", "def ", "class ", "for ", "while ", "if ", "#", "metadata")
    return any(l.strip().startswith(indicators) for l in lines[:5])


def _print_message(role, content):
    """Display a full message from chat history with proper formatting."""
    if role == "user":
        print(f"\n  {_c('You:', C.WHITE + C.BOLD)} {content}")
    else:
        # Check for code blocks in the message
        parts = re.split(r"(```(?:\w*)\n.*?```)", content, flags=re.DOTALL)

        print(f"\n  {_c('🤖 BioBot:', C.GREEN + C.BOLD)}")
        for part in parts:
            if part.startswith("```"):
                # Extract code from fences
                code = re.sub(r"^```\w*\n", "", part)
                code = re.sub(r"\n?```$", "", code)
                _print_code(code)
            else:
                stripped = part.strip()
                if stripped:
                    for line in stripped.split("\n"):
                        print(f"  {line}")


def _read_files_for_attachment(paths):
    """Read files and format them as a single text block for the LLM."""
    chunks = []
    for path in paths:
        if not os.path.exists(path):
            print(_c(f"  ⚠️  File not found: {path}", C.YELLOW))
            continue
        try:
            with open(path, "r") as f:
                content = f.read()
            chunks.append(
                f"[Attached file: {os.path.basename(path)}]\n{content}\n[End of file]"
            )
            print(_c(f"  📎 Attached: {path}", C.DIM))
        except Exception as e:
            print(_c(f"  ⚠️  Cannot read {path}: {e}", C.YELLOW))
    return "\n\n".join(chunks)


# ── Chat selection ───────────────────────────────────────────

def pick_or_create_chat(session: Session) -> str:
    chats = list_user_chats(session)

    if not chats:
        print(_c("  No existing chats. Creating a new one...", C.DIM))
        return create_new_chat(session)

    print(_c("  Your chats:", C.WHITE + C.BOLD))
    for i, ch in enumerate(chats):
        print(f"    {_c(str(i + 1) + '.', C.CYAN)} {ch['name']}")
    print(f"    {_c('0.', C.CYAN)} + New chat")
    print()

    while True:
        choice = _ask(_c("  Select a chat (number): ", C.WHITE))
        if not choice:
            continue
        if choice == "0":
            return create_new_chat(session)
        if choice.isdigit() and 1 <= int(choice) <= len(chats):
            return chats[int(choice) - 1]["chat_id"]
        print(_c("  Invalid choice.", C.RED))


# ── Main interaction loop ────────────────────────────────────

MODEL_NAME = "gpt-5.4"

def interactive(session: Session, chat_id: str, initial_files=None):
    _banner()

    # Show recent history
    history = get_chat_history(session, chat_id)
    visible = [m for m in history if m["role"] != "system"]
    if visible:
        print(_c("  ── Chat history ──", C.DIM))
        for m in visible[-6:]:
            _print_message(m["role"], m["content"])
        print(_c("\n  ── End of history ──\n", C.DIM))
    else:
        print(f"  {_c('🤖 BioBot:', C.GREEN + C.BOLD)} Hello! I'm Biobot 🧬 — ready to help with lab automation.\n")

    last_code = None
    pending_files = list(initial_files) if initial_files else []

    if pending_files:
        print(_c(f"  📎 {len(pending_files)} file(s) attached — will be sent with your next message:", C.CYAN))
        for f in pending_files:
            print(_c(f"     • {f}", C.DIM))
        print()

    while True:
        try:
            user_input = input(_c("  You: ", C.BOLD + C.WHITE)).strip()
        except (KeyboardInterrupt, EOFError):
            print(_c("\n\n  Goodbye!\n", C.GREEN))
            break

        if not user_input:
            continue

        # ── Slash commands ──
        if user_input.startswith("/"):
            cmd = user_input.lower().split()

            if cmd[0] in ("/quit", "/exit", "/q"):
                print(_c("\n  Goodbye!\n", C.GREEN))
                break

            elif cmd[0] == "/new":
                chat_id = create_new_chat(session)
                print(_c("  New chat started.\n", C.GREEN))
                last_code = None
                continue

            elif cmd[0] == "/list":
                chats = list_user_chats(session)
                if not chats:
                    print(_c("  No saved chats.", C.DIM))
                else:
                    print()
                    for i, ch in enumerate(chats):
                        marker = _c(" ◀", C.GREEN) if ch["chat_id"] == chat_id else ""
                        print(f"    {_c(str(i + 1) + '.', C.CYAN)} {ch['name']}{marker}")
                    print()
                continue

            elif cmd[0] == "/switch":
                chats = list_user_chats(session)
                if len(cmd) > 1 and cmd[1].isdigit():
                    idx = int(cmd[1]) - 1
                    if 0 <= idx < len(chats):
                        chat_id = chats[idx]["chat_id"]
                        print(_c(f"  Switched to: {chats[idx]['name']}", C.GREEN))
                        hist = get_chat_history(session, chat_id)
                        visible = [x for x in hist if x["role"] != "system"]
                        for m in visible[-6:]:
                            _print_message(m["role"], m["content"])
                        print()
                    else:
                        print(_c("  Invalid number.", C.RED))
                else:
                    print(_c("  Usage: /switch <number>", C.DIM))
                continue

            elif cmd[0] == "/save":
                if last_code:
                    fname = cmd[1] if len(cmd) > 1 else "biobot_protocol.py"
                    # Save to the directory where the user ran biobot from
                    save_dir = os.environ.get("BIOBOT_SAVE_DIR", str(PROJECT_DIR))
                    save_path = os.path.join(save_dir, fname)
                    with open(save_path, "w") as f:
                        f.write(last_code)
                    print(_c(f"  Saved to {save_path}", C.GREEN))
                else:
                    print(_c("  No code to save yet.", C.DIM))
                continue

            elif cmd[0] == "/delete":
                chats = list_user_chats(session)
                if len(cmd) > 1 and cmd[1].isdigit():
                    idx = int(cmd[1]) - 1
                    if 0 <= idx < len(chats):
                        target = chats[idx]
                        delete_chat_db(session, target["chat_id"])
                        print(_c(f"  Deleted: {target['name']}", C.YELLOW))
                        if target["chat_id"] == chat_id:
                            chat_id = create_new_chat(session)
                            print(_c("  Started new chat.", C.GREEN))
                    else:
                        print(_c("  Invalid number.", C.RED))
                else:
                    print(_c("  Usage: /delete <number>", C.DIM))
                continue

            elif cmd[0] == "/upload":
                # Use original (case-preserving) split for paths
                raw_parts = user_input.split(maxsplit=1)
                if len(raw_parts) < 2:
                    print(_c("  Usage: /upload <file_path> [<file_path> ...]", C.DIM))
                    continue
                # Split remaining on whitespace to support multiple files
                file_paths = raw_parts[1].split()
                added = 0
                for fp in file_paths:
                    fp_expanded = os.path.expanduser(fp)
                    if not os.path.exists(fp_expanded):
                        print(_c(f"  ⚠️  File not found: {fp}", C.YELLOW))
                        continue
                    pending_files.append(fp_expanded)
                    added += 1
                if added:
                    print(_c(f"  📎 {added} file(s) attached. Will be sent with your next message.", C.GREEN))
                continue

            elif cmd[0] == "/files":
                if not pending_files:
                    print(_c("  No files attached.", C.DIM))
                else:
                    print(_c("  Attached files:", C.WHITE + C.BOLD))
                    for f in pending_files:
                        print(f"    • {f}")
                continue

            elif cmd[0] == "/clear-files":
                pending_files = []
                print(_c("  Cleared all attached files.", C.GREEN))
                continue

            elif cmd[0] == "/help":
                _banner()
                continue

            else:
                print(_c(f"  Unknown command: {cmd[0]}", C.DIM))
                continue

        # ── Send message to engine ──

        # If there are pending files, prepend their content to the user message
        message_to_send = user_input
        if pending_files:
            file_block = _read_files_for_attachment(pending_files)
            if file_block:
                message_to_send = f"{file_block}\n\nUser message: {user_input}"
            pending_files = []  # consumed

        save_message(session, chat_id, "user", message_to_send)
        auto_rename_chat(session, chat_id, user_input)  # use the short version for chat name

        messages = get_chat_history(session, chat_id)

        full_reply = ""
        had_status = False
        is_rag = False

        try:
            for chunk in process_user_query(message_to_send, messages, MODEL_NAME, api_key=session.api_key):

                if chunk.startswith(RAG_STATUS_PREFIX):
                    had_status = True
                    is_rag = True
                    _print_status(chunk[len(RAG_STATUS_PREFIX):])
                    continue

                if chunk.startswith(FAILED_CODE_MARKER):
                    if had_status:
                        _clear_status()
                    content = chunk[len(FAILED_CODE_MARKER):]
                    parts = content.split("___CODE_SEP___", 1)
                    message = parts[0].strip()
                    code = parts[1].strip() if len(parts) > 1 else ""

                    print(f"\n  {_c('⚠️  BioBot:', C.YELLOW + C.BOLD)}")
                    for line in message.split("\n"):
                        print(f"  {line}")
                    if code:
                        _print_code(code)
                        last_code = code

                    save_content = message + ("\n\n```python\n" + code + "\n```" if code else "")
                    save_message(session, chat_id, "assistant", save_content)
                    full_reply = save_content
                    continue

                if had_status and not full_reply:
                    _clear_status()
                    print()
                    had_status = False

                if not full_reply:
                    print(f"\n  {_c('🤖 BioBot:', C.GREEN + C.BOLD)}")

                full_reply += chunk
                sys.stdout.write(chunk)
                sys.stdout.flush()

        except KeyboardInterrupt:
            print(_c("\n  [interrupted]", C.DIM))
            continue
        except Exception as e:
            _clear_status()
            print(_c(f"\n  Error: {e}", C.RED))
            continue

        if full_reply:
            if is_rag and _looks_like_code(full_reply) and "```" not in full_reply:
                _clear_status()
                if had_status:
                    print(f"\n  {_c('🤖 BioBot:', C.GREEN + C.BOLD)}")
                _print_code(full_reply)
                last_code = full_reply
                save_message(session, chat_id, "assistant", "```python\n" + full_reply + "\n```")
            elif not full_reply.startswith(FAILED_CODE_MARKER):
                print()
                save_message(session, chat_id, "assistant", full_reply)

                blocks = re.findall(r"```(?:\w*)\n(.*?)```", full_reply, re.DOTALL)
                if blocks:
                    last_code = blocks[-1].strip()

        print()


# ── Entry point ──────────────────────────────────────────────

# ── Command implementations ──────────────────────────────────

def cmd_generate(args):
    """Generate transfer instructions from source/destination plate CSVs."""
    source_path = args.source
    dest_path = args.dest
    output_path = args.output

    print()
    print(_c("  🧬 BioBot — Plate Transfer Instructions Generator", C.GREEN + C.BOLD))
    print()

    for path in [source_path, dest_path]:
        if not os.path.exists(path):
            print(_c(f"  File not found: {path}", C.RED))
            sys.exit(1)

    with open(source_path, "r") as f:
        source_csv = f.read()
    with open(dest_path, "r") as f:
        dest_csv = f.read()

    print(f"  Source plate:      {_c(source_path, C.CYAN)}")
    print(f"  Destination plate: {_c(dest_path, C.CYAN)}")
    print(f"  Output:            {_c(output_path, C.CYAN)}")
    print()

    try:
        api_key = get_api_key()
    except ValueError as e:
        print(_c(f"  {e}", C.RED))
        sys.exit(1)

    _print_status("Analyzing plates and generating transfer instructions...")

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)

        response = client.responses.create(
            model="gpt-5",
            input=[
                {
                    "role": "system",
                    "content": """You are an expert in lab automation and liquid handling.

You will receive two CSV files:
1. A SOURCE PLATE: describes available reagents in each well and their volumes.
2. A DESTINATION PLATE: describes the target composition of each well — what reagents and how much of each should end up in each well.

Your task: generate a TRANSFER INSTRUCTIONS CSV that tells a liquid handler how to pipette from source wells to destination wells to achieve the desired destination plate.

RULES:
- For each destination well and each reagent it needs, find the appropriate source well that contains that reagent.
- Each row in the output represents one transfer: from one source well to one destination well for one specific reagent.
- Track cumulative volumes taken from each source well. If a source well runs out, flag it or split across multiple source wells if available.
- If a reagent needed in the destination is not available in any source well, add a warning comment.
- Output ONLY the CSV content, no markdown fences, no explanation, no preamble.
- Use comma as delimiter.
- Volumes in the output should use the same unit as the input files."""
                },
                {
                    "role": "user",
                    "content": f"Generate transfer instructions.\n\nSOURCE PLATE ({source_path}):\n{source_csv}\n\nDESTINATION PLATE ({dest_path}):\n{dest_csv}"
                }
            ]
        )

        result = response.output_text.strip()
        if result.startswith("```"):
            result = re.sub(r"^```(?:csv)?\n?", "", result)
            result = re.sub(r"\n?```$", "", result)

        _clear_status()

        with open(output_path, "w") as f:
            f.write(result + "\n")

        lines = result.strip().split("\n")
        num_rows = len(lines) - 1

        print(f"  {_c('✅', C.GREEN)} Generated {_c(str(num_rows), C.BOLD)} transfer instructions")
        print(f"  {_c('📄', C.GREEN)} Saved to: {_c(output_path, C.CYAN)}")
        print()
        print(_c("  ── Preview ──", C.DIM))
        for line in lines[:min(10, len(lines))]:
            print(f"  {line}")
        if len(lines) > 10:
            print(_c(f"  ... ({num_rows} rows total)", C.DIM))
        print()

    except Exception as e:
        _clear_status()
        print(_c(f"\n  Error: {e}", C.RED))
        sys.exit(1)


def cmd_ask(args):
    """One-shot, non-interactive query. No login, no DB, no clarification."""
    prompt = args.prompt
    output = args.output

    # Get API key
    try:
        api_key = get_api_key()
    except ValueError as e:
        print(_c(f"  {e}", C.RED))
        sys.exit(1)

    # Tell main_rag to skip the sufficient-info check
    os.environ["BIOBOT_SKIP_SUFFICIENT_CHECK"] = "1"

    # Build a minimal message history with just the system prompt + user prompt
    messages = [
        {"role": "system", "content": ONE_SHOT_SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    print()
    print(_c("  🧬 BioBot — One-shot query", C.GREEN + C.BOLD))
    print()
    print(f"  {_c('You:', C.WHITE + C.BOLD)} {prompt}")
    print()

    full_reply = ""
    had_status = False

    try:
        for chunk in process_user_query(prompt, messages, MODEL_NAME, api_key=api_key):

            if chunk.startswith(RAG_STATUS_PREFIX):
                had_status = True
                _print_status(chunk[len(RAG_STATUS_PREFIX):])
                continue

            if chunk.startswith(FAILED_CODE_MARKER):
                if had_status:
                    _clear_status()
                content = chunk[len(FAILED_CODE_MARKER):]
                parts = content.split("___CODE_SEP___", 1)
                message = parts[0].strip()
                code = parts[1].strip() if len(parts) > 1 else ""
                print(f"\n  {_c('⚠️  BioBot:', C.YELLOW + C.BOLD)}")
                for line in message.split("\n"):
                    print(f"  {line}")
                if code:
                    _print_code(code)
                full_reply = message + ("\n\n```python\n" + code + "\n```" if code else "")
                continue

            if had_status and not full_reply:
                _clear_status()
                print(f"\n  {_c('🤖 BioBot:', C.GREEN + C.BOLD)}")
                had_status = False

            if not full_reply:
                print(f"\n  {_c('🤖 BioBot:', C.GREEN + C.BOLD)}")

            full_reply += chunk
            sys.stdout.write(chunk)
            sys.stdout.flush()

    except KeyboardInterrupt:
        print(_c("\n  [interrupted]", C.DIM))
        sys.exit(130)
    except Exception as e:
        _clear_status()
        print(_c(f"\n  Error: {e}", C.RED))
        sys.exit(1)

    print("\n")

    # Save to file if requested
    if output and full_reply:
        with open(output, "w") as f:
            f.write(full_reply)
        print(_c(f"  📄 Response saved to: {output}\n", C.GREEN))


def cmd_web(args):
    """Open the web UI in the default browser."""
    import webbrowser
    url = args.url

    print()
    print(_c("  🧬 BioBot — Web UI", C.GREEN + C.BOLD))
    print()
    print(f"  Opening {_c(url, C.CYAN)} in your browser...")
    print()
    print(_c("  If the page doesn't load, make sure the web service is running:", C.DIM))
    print(_c("    docker compose up -d", C.DIM))
    print()

    webbrowser.open(url)


# ── Entry point ──────────────────────────────────────────────

# System prompt used specifically for one-shot queries (no clarification)
ONE_SHOT_SYSTEM_PROMPT = (
    "You are BioBot 🤖, an expert assistant specialized in lab automation, "
    "particularly with liquid handling robots. Generate clean, error-free Python "
    "code for operating lab robots when asked. Do your best with whatever info "
    "the user provides — make reasonable assumptions if details are missing, "
    "and state them clearly. Never ask the user for more information — always "
    "provide a complete answer based on what was given. Decline requests "
    "unrelated to lab automation kindly."
)


def main():
    parser = argparse.ArgumentParser(
        prog="biobot",
        description="BioBot CLI — lab automation code generator",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")

    # ── chat (interactive, default) ──
    chat_p = subparsers.add_parser(
        "chat",
        help="Interactive chat (default)",
        description="Start an interactive chat session. Login required.",
    )
    chat_p.add_argument("-f", "--files", nargs="+", metavar="FILE",
                        help="Attach file(s) to the first message")
    chat_p.add_argument("--new", action="store_true",
                        help="Start a new chat directly (skip chat selection)")

    # ── ask (one-shot) ──
    ask_p = subparsers.add_parser(
        "ask",
        help="One-shot non-interactive query",
        description="Send a single prompt and get a single response. No login, no clarification, no chat history.",
    )
    ask_p.add_argument("prompt", help="The prompt to send")
    ask_p.add_argument("-o", "--output", help="Save the response to a file")

    # ── generate (plate transfer) ──
    gen_p = subparsers.add_parser(
        "generate",
        help="Generate transfer instructions from plate CSVs",
        description="Read source and destination plate CSVs and generate liquid handler transfer instructions.",
    )
    gen_p.add_argument("source", metavar="SOURCE_CSV", help="Source plate CSV")
    gen_p.add_argument("dest", metavar="DEST_CSV", help="Destination plate CSV")
    gen_p.add_argument("-o", "--output", default="instructions.csv",
                       help="Output path (default: instructions.csv)")

    # ── web ──
    web_p = subparsers.add_parser(
        "web",
        help="Open the web UI in your browser",
        description="Open the BioBot web UI. Make sure docker compose is running.",
    )
    web_p.add_argument("--url", default="http://localhost:5000",
                       help="URL to open (default: http://localhost:5000)")

    # ── register ──
    subparsers.add_parser(
        "register",
        help="Create a new account",
    )

    # ── init-db ──
    subparsers.add_parser(
        "init-db",
        help="Initialize database tables",
    )

    # ── list ──
    subparsers.add_parser(
        "list",
        help="List your saved chats",
    )

    args = parser.parse_args()

    # ── Default to chat if no subcommand ──
    if args.command is None:
        args.command = "chat"
        args.files = None
        args.new = False

    # ── Dispatch ──

    # Commands that don't need DB connection
    if args.command == "generate":
        cmd_generate(args)
        return

    if args.command == "ask":
        cmd_ask(args)
        return

    if args.command == "web":
        cmd_web(args)
        return

    if args.command == "init-db":
        try:
            wait_for_postgres()
            init_db()
            print(_c("  Database initialized.", C.GREEN))
        except Exception as e:
            print(_c(f"  Error: {e}", C.RED))
            sys.exit(1)
        return

    # Commands below require DB connectivity
    try:
        conn = get_db_connection()
        conn.close()
    except Exception as e:
        print(_c(f"\n  Cannot connect to database: {e}", C.RED))
        print(_c("  Make sure Postgres is running: docker compose up -d postgres", C.DIM))
        print(_c("  And check your .env file in the project root.\n", C.DIM))
        sys.exit(1)

    if args.command == "register":
        register_prompt()
        return

    # Login required
    session = login_prompt()

    if args.command == "list":
        chats = list_user_chats(session)
        if not chats:
            print(_c("  No saved chats.", C.DIM))
        else:
            for i, ch in enumerate(chats):
                print(f"  {i + 1}. {ch['name']}")
        return

    # chat command
    if args.command == "chat":
        if args.new:
            chat_id = create_new_chat(session)
        else:
            chat_id = pick_or_create_chat(session)

        interactive(session, chat_id, initial_files=args.files)
        return


if __name__ == "__main__":
    main()