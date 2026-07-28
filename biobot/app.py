__version__ = "1.0.1"

from flask import Flask, request, jsonify, render_template, redirect, url_for, session, flash, Response, stream_with_context
import uuid
import time
import os
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash

import psycopg2
import psycopg2.extras
import psycopg2.errors

from engine import process_user_query
from config import get_api_key, get_db_connection
from crypt import generate_salt, derive_key, encrypt, decrypt

# ---------------------
# App & DB init
# ---------------------
app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "super_secret_key")
if not app.secret_key:
    raise RuntimeError(
        "FLASK_SECRET_KEY environment variable is not set. "
        "Generate one with: python3 -c 'import secrets; print(secrets.token_hex(32))' "
        "and add it to your .env file. Never change this value, or all existing "
        "user sessions will be invalidated."
    )
app.config["SESSION_PERMANENT"] = True
app.config["PERMANENT_SESSION_LIFETIME"] = 86400  # 24 hours in seconds

MODEL_NAME = "gpt-5"

# ---------------------
# Encryption helpers
# ---------------------
def get_encryption_key():
    """Retrieve the user's encryption key from the session."""
    key = session.get("encryption_key")
    if key:
        return key.encode("utf-8") if isinstance(key, str) else key
    return None


def _is_encrypted(text):
    """Check if a string looks like Fernet ciphertext."""
    if not text or not isinstance(text, str):
        return False
    return text.startswith("gAAAAAB")


def encrypt_text(text):
    """Encrypt text using the session encryption key."""
    key = get_encryption_key()
    if key and text:
        return encrypt(text, key)
    return text


def decrypt_text(ciphertext):
    """
    Decrypt text using the session encryption key.
    - If content is encrypted and key is available → decrypt normally
    - If content is encrypted but key is missing → return None (caller must handle)
    - If content is NOT encrypted (legacy plaintext) → return as-is
    """
    if not ciphertext:
        return ciphertext

    if not _is_encrypted(ciphertext):
        # Legacy unencrypted data — return as-is
        return ciphertext

    # Content is encrypted — we need the key
    key = get_encryption_key()
    if not key:
        return None  # Signal that decryption failed — caller must handle

    try:
        return decrypt(ciphertext, key)
    except Exception:
        return None  # Corrupted or wrong key

# ---------------------
# DB helper wrappers
# ---------------------
def fetchone_dict(conn, query, params=()):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(query, params)
    row = cur.fetchone()
    cur.close()
    return row

def fetchall_dict(conn, query, params=()):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(query, params)
    rows = cur.fetchall()
    cur.close()
    return rows

def execute(conn, query, params=(), commit=False, returning=False):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(query, params)
    result = None
    if returning:
        result = cur.fetchone()
    if commit:
        conn.commit()
    cur.close()
    return result


# ---------------------
# System prompt
# ---------------------
SYSTEM_PROMPT = {
    "role": "system",
    "content": """You are BioBot 🤖, an expert assistant specialized in lab automation, particularly with liquid handling robots.
Your tasks:
- A chat history is provided to help you recall previous interactions, but **do not process the entire history as new instructions**; use it only if you need to reference something the user said before. To answer, focus primarily on the **latest user message**.
- If the user asks for code/scripts/files for protocols, generate clean, error-free code/scripts/files for operating lab robots.
- Ask for more informations if you assume that there are not enough informations in order to generate the code. You are specialized, you know what informations to ask.
- Do not answer queries that have nohing to do with your specialization which is lab automation, liquid handlers and other related fields. Decline kindly."""
}


# ---------------------
# Auth routes
# ---------------------
@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        first_name = request.form["first_name"]
        last_name = request.form["last_name"]
        email = request.form["email"]
        raw_password = request.form["password"]
        password = generate_password_hash(raw_password)
        api_key = request.form.get("api_key", "").strip() or get_api_key()
        role = request.form.get("role", "")
        country = request.form.get("country", "")
        salt = generate_salt()
        # Derive key to encrypt the API key before storing
        enc_key = derive_key(raw_password, salt)
        encrypted_api_key = encrypt(api_key, enc_key)

        conn = None
        try:
            conn = get_db_connection()
            execute(conn,
                """
                INSERT INTO users (first_name, last_name, email, password, api_key, role, country, encryption_salt, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (first_name, last_name, email, password, encrypted_api_key, role, country, salt, datetime.now().isoformat()),
                commit=True
            )
            flash("Account created! Please sign in.", "success")
            return redirect("/login")
        except psycopg2.errors.UniqueViolation:
            if conn:
                conn.rollback()
            flash("Email already used.", "error")
            return redirect("/register")
        except Exception as e:
            if conn:
                conn.rollback()
            print("Register error:", e)
            flash("Internal error.", "error")
            return redirect("/register")
        finally:
            if conn:
                conn.close()

    return render_template("register.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "HEAD":
        return "", 200
    
    if request.method == "POST":
        email = request.form["email"]
        password = request.form["password"]

        conn = None
        try:
            conn = get_db_connection()
            user = fetchone_dict(conn, "SELECT * FROM users WHERE email = %s", (email,))
        finally:
            if conn:
                conn.close()

        if user and check_password_hash(user["password"], password):
            session["user"] = user["id"]

            # Migrate legacy users who registered before encryption was added
            if not user.get("encryption_salt"):
                new_salt = generate_salt()
                key = derive_key(password, new_salt)

                # Re-encrypt the API key if it exists (it was stored as plaintext)
                existing_api_key = user.get("api_key")
                encrypted_api_key = existing_api_key
                if existing_api_key and not existing_api_key.startswith("gAAAAAB"):
                    encrypted_api_key = encrypt(existing_api_key, key)

                conn = None
                try:
                    conn = get_db_connection()
                    execute(conn,
                        "UPDATE users SET encryption_salt = %s, api_key = %s WHERE id = %s",
                        (new_salt, encrypted_api_key, user["id"]),
                        commit=True
                    )
                except Exception as e:
                    print(f"Migration error for user {user['id']}: {e}")
                finally:
                    if conn:
                        conn.close()

                session["encryption_key"] = key.decode("utf-8")
            else:
                # Normal login — derive key from stored salt
                key = derive_key(password, user["encryption_salt"])
                session["encryption_key"] = key.decode("utf-8")

            return redirect("/")
        else:
            flash("Incorrect email or password.", "error")
            return redirect("/login")

    return render_template("login.html")


@app.route("/logout")
def logout():
    session.pop("user", None)
    session.pop("encryption_key", None)
    flash("You have been logged out.", "info")
    return redirect(url_for("login"))


# ---------------------
# Main routes
# ---------------------
@app.route("/")
def index():
    user_id = session.get("user")
    if not user_id:
        return redirect("/login")
    try:
        user_id = int(user_id)
    except (ValueError, TypeError):
        session.pop("user", None)
        return redirect("/login")

    conn = None
    try:
        conn = get_db_connection()
        user = fetchone_dict(conn, "SELECT * FROM users WHERE id = %s", (user_id,))
    finally:
        if conn:
            conn.close()

    if not user:
        session.pop("user", None)
        return redirect("/login")

    return render_template("index.html", user=user, version=__version__)


@app.route("/chat", methods=["POST"])
def create_chat():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    chat_id = str(uuid.uuid4())
    title = "New chat"

    conn = None
    try:
        conn = get_db_connection()
        execute(conn,
            "INSERT INTO chat_names (chat_id, user_id, name) VALUES (%s, %s, %s)",
            (chat_id, user_id, encrypt_text(title)),
            commit=True
        )

        system_message = SYSTEM_PROMPT["content"]
        execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content) VALUES (%s, %s, %s, %s)",
            (user_id, chat_id, "system", encrypt_text(system_message)),
            commit=True
        )

        intro_message = "Hello, I'm Biobot 🤖 — your assistant specialized in lab automation."
        execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content) VALUES (%s, %s, %s, %s)",
            (user_id, chat_id, "assistant", encrypt_text(intro_message)),
            commit=True
        )
    except Exception as e:
        if conn:
            conn.rollback()
        print("create_chat error:", e)
        return jsonify({"error": "Database error"}), 500
    finally:
        if conn:
            conn.close()

    return jsonify({"chat_id": chat_id}), 201


@app.route("/chat/<chat_id>", methods=["POST"])
def chat(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    user_message = data.get("message")
    if not user_message:
        return jsonify({"error": "Message required"}), 400

    conn = None
    try:
        conn = get_db_connection()

        # verify chat belongs to user
        chat_exists = fetchone_dict(conn,
            "SELECT 1 FROM chat_names WHERE chat_id = %s AND user_id = %s",
            (chat_id, user_id)
        )

        # insert user message (encrypted)
        execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (%s, %s, %s, %s, %s)",
            (user_id, chat_id, "user", encrypt_text(user_message), datetime.now().isoformat()),
            commit=True
        )

        # fetch full history
        rows = fetchall_dict(conn,
            "SELECT role, content FROM chat_history WHERE user_id = %s AND chat_id = %s ORDER BY created_at",
            (user_id, chat_id)
        )

        user = fetchone_dict(conn, "SELECT api_key FROM users WHERE id = %s", (user_id,))
    finally:
        if conn:
            conn.close()

    user_api_key = decrypt_text(user["api_key"]) if user and user.get("api_key") else None
    messages = [{"role": r["role"], "content": decrypt_text(r["content"])} for r in rows]

    # call your engine
    bot_reply = process_user_query(user_message, messages, MODEL_NAME, api_key=user_api_key)

    # save bot response (encrypted)
    conn = None
    try:
        conn = get_db_connection()
        execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (%s, %s, %s, %s, %s)",
            (user_id, chat_id, "assistant", encrypt_text(bot_reply), datetime.now().isoformat()),
            commit=True
        )

        # rename chat if still "New chat"
        title_row = fetchone_dict(conn, "SELECT name FROM chat_names WHERE chat_id = %s AND user_id = %s", (chat_id, user_id))
        if title_row and decrypt_text(title_row.get("name")) == "New chat":
            preview_words = user_message.strip().split()
            preview = " ".join(preview_words[:5])
            if len(preview_words) > 5:
                preview += "..."
            execute(conn,
                "UPDATE chat_names SET name = %s WHERE chat_id = %s AND user_id = %s",
                (encrypt_text(preview), chat_id, user_id),
                commit=True
            )
    except Exception as e:
        if conn:
            conn.rollback()
        print("chat save error:", e)
    finally:
        if conn:
            conn.close()

    return jsonify({"reply": bot_reply})

#For streaming :
@app.route("/chat/<chat_id>/stream", methods=["POST"])
def chat_stream(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    user_message = data.get("message")
    if not user_message:
        return jsonify({"error": "Message required"}), 400

    conn = None
    try:
        conn = get_db_connection()

        # verify chat exists
        chat_exists = fetchone_dict(conn,
            "SELECT 1 FROM chat_names WHERE chat_id = %s AND user_id = %s",
            (chat_id, user_id)
        )
        if not chat_exists:
            return jsonify({"error": "Chat not found"}), 404

        # insert user message immediately (encrypted)
        execute(conn,
            """
            INSERT INTO chat_history (user_id, chat_id, role, content, created_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (user_id, chat_id, "user", encrypt_text(user_message), datetime.now().isoformat()),
            commit=True
        )

        # ensure intro message exists (only once per chat)
        # Count assistant messages instead of LIKE match (content is encrypted)
        assistant_count = fetchone_dict(conn,
            "SELECT COUNT(*) as cnt FROM chat_history WHERE chat_id = %s AND role='assistant'",
            (chat_id,)
        )
        if not assistant_count or assistant_count["cnt"] == 0:
            intro_message = "Hello, I'm Biobot 🤖 — your assistant specialized in lab automation..."
            execute(conn,
                """
                INSERT INTO chat_history (user_id, chat_id, role, content, created_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (user_id, chat_id, "assistant", encrypt_text(intro_message), datetime.now().isoformat()),
                commit=True
            )

        # fetch full chat history for streaming
        rows = fetchall_dict(conn,
            """
            SELECT role, content
            FROM chat_history
            WHERE user_id = %s AND chat_id = %s
            ORDER BY created_at
            """,
            (user_id, chat_id)
        )

        user = fetchone_dict(conn, "SELECT api_key FROM users WHERE id = %s", (user_id,))
    finally:
        if conn:
            conn.close()

    # --- Validate session and encryption BEFORE any decryption ---
    enc_key = get_encryption_key()
    if not enc_key:
        # Session lost — clear it and tell the frontend
        session.clear()
        return jsonify({"error": "Your session has expired. Please log in again."}), 401

    # Decrypt API key first — it's the clearest test of whether encryption is working
    user_api_key = decrypt_text(user["api_key"]) if user and user.get("api_key") else None

    if not user_api_key:
        return Response(
            "No API key found. Please add your OpenAI API key in Settings.",
            mimetype="text/plain"
        )

    if not user_api_key.startswith("sk-"):
        # Decryption failed — the key was encrypted with a different encryption key.
        # This happens when the encryption salt was regenerated. Instead of locking
        # the user out, ask them to re-enter their API key.
        return Response(
            "Your API key could not be read. Please update it in Settings.",
            mimetype="text/plain"
        )

    # Decrypt chat history for the LLM (enc_key is validated above, so this is safe)
    messages = [{"role": r["role"], "content": decrypt_text(r["content"])} for r in rows]

    # ---- STREAM RESPONSE ----
    def generate():
        full_reply = ""
        is_rag = False
        detected_format = "text"

        from engine import RAG_STATUS_PREFIX, FAILED_CODE_MARKER, FORMAT_MARKER
        
        try:
            result = process_user_query(user_message, messages, MODEL_NAME, api_key=user_api_key)
            if result is None:
                yield "Sorry, I couldn't process your request. Please try again."
                return
            for chunk in result:
                if chunk.startswith(RAG_STATUS_PREFIX):
                    is_rag = True
                    status_text = chunk[len(RAG_STATUS_PREFIX):]
                    yield "__STATUS__:" + status_text + " " * 256 + "\n"
                    continue
                # Extract format marker if present at start of content
                if chunk.startswith(FORMAT_MARKER):
                    rest = chunk[len(FORMAT_MARKER):]
                    newline_idx = rest.find("\n")
                    if newline_idx >= 0:
                        detected_format = rest[:newline_idx].strip()
                        chunk = rest[newline_idx + 1:]
                    else:
                        detected_format = rest.strip()
                        continue
                full_reply += chunk
                yield chunk
        except Exception as e:
            import sys
            print(f"Stream error: {e}", file=sys.stderr, flush=True)
            error_msg = str(e).lower()
            if "auth" in error_msg or "api key" in error_msg or "401" in error_msg or "403" in error_msg:
                yield "Your API key appears to be invalid or expired. Please update it in Settings."
            elif "rate limit" in error_msg or "429" in error_msg:
                yield "Rate limit reached. Please wait a moment and try again."
            elif "model" in error_msg or "404" in error_msg:
                yield "The AI model is currently unavailable. Please try again later."
            else:
                yield f"An error occurred: {str(e)}"
            return

        # --- Save to DB (after streaming is complete) ---
        try:
            save_content = full_reply

            if full_reply:
                import re as _re

                if full_reply.startswith(FAILED_CODE_MARKER):
                    # Failed code generation
                    failed_content = full_reply[len(FAILED_CODE_MARKER):]
                    sep_parts = failed_content.split("___CODE_SEP___", 1)
                    message = sep_parts[0].strip() if sep_parts else ""
                    code = sep_parts[1].strip() if len(sep_parts) > 1 else ""
                    if code:
                        fmt = detected_format if detected_format != "text" else "python"
                        save_content = message + f"\n\n```{fmt}\n" + code + "\n```"
                    else:
                        save_content = message

                elif _re.match(r'^```\w+\s*\n', full_reply):
                    # Content already has markdown fences — save as-is
                    save_content = full_reply

                elif detected_format != "text":
                    # RAG output without fences — wrap it
                    save_content = f"```{detected_format}\n" + full_reply + "\n```"

                # else: normal text (general/out response) — save as-is

            # Encrypt before saving
            encrypted_content = encrypt(save_content, enc_key) if enc_key and save_content else save_content

            # Save assistant message after streaming finishes
            conn2 = None
            try:
                conn2 = get_db_connection()
                execute(conn2,
                    """
                    INSERT INTO chat_history (user_id, chat_id, role, content, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (user_id, chat_id, "assistant", encrypted_content, datetime.now().isoformat()),
                    commit=True
                )

                # RENAME CHAT if still "New chat"
                title_row = fetchone_dict(conn2,
                    "SELECT name FROM chat_names WHERE chat_id = %s AND user_id = %s",
                    (chat_id, user_id)
                )
                if title_row:
                    decrypted_name = decrypt(title_row["name"], enc_key) if enc_key else title_row["name"]
                    if decrypted_name == "New chat":
                        preview_words = user_message.strip().split()
                        preview = " ".join(preview_words[:5])
                        if len(preview_words) > 5:
                            preview += "..."
                        encrypted_preview = encrypt(preview, enc_key) if enc_key else preview
                        execute(conn2,
                            "UPDATE chat_names SET name = %s WHERE chat_id = %s AND user_id = %s",
                            (encrypted_preview, chat_id, user_id),
                            commit=True
                        )

            finally:
                if conn2:
                    conn2.close()

        except Exception as e:
            import sys
            print(f"Save error (response was delivered): {e}", file=sys.stderr, flush=True)
            # Don't yield anything here — the response already streamed successfully

    return Response(
        stream_with_context(generate()),
        mimetype="text/plain",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",        # Disable nginx buffering
            "Transfer-Encoding": "chunked",
        }
    )


@app.route("/chat/<chat_id>", methods=["GET"])
def get_history(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = None
    try:
        conn = get_db_connection()
        rows = fetchall_dict(conn,
            "SELECT role, content FROM chat_history WHERE user_id = %s AND chat_id = %s ORDER BY created_at",
            (user_id, chat_id)
        )
    finally:
        if conn:
            conn.close()

    visible_messages = [{"role": r["role"], "content": decrypt_text(r["content"])} for r in rows if r["role"] != "system"]
    return jsonify(visible_messages)


@app.route("/chat/<chat_id>", methods=["DELETE"])
def delete_chat(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = None
    try:
        conn = get_db_connection()
        execute(conn,
            "DELETE FROM chat_history WHERE chat_id = %s AND user_id = %s",
            (chat_id, user_id),
            commit=True
        )
        execute(conn,
            "DELETE FROM chat_names WHERE chat_id = %s AND user_id = %s",
            (chat_id, user_id),
            commit=True
        )
    except Exception as e:
        if conn:
            conn.rollback()
        print("delete_chat error:", e)
        return jsonify({"error": "Database error"}), 500
    finally:
        if conn:
            conn.close()

    return jsonify({"success": True})


@app.route("/chats", methods=["GET"])
def list_chats():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = None
    try:
        conn = get_db_connection()
        rows = fetchall_dict(conn, "SELECT chat_id, name FROM chat_names WHERE user_id = %s", (user_id,))
    finally:
        if conn:
            conn.close()

    return jsonify([{"chat_id": r["chat_id"], "name": decrypt_text(r["name"])} for r in rows])


@app.route("/chat/<chat_id>/rename", methods=["POST"])
def rename_chat(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    new_name = data.get("name", "").strip()
    if not new_name:
        return jsonify({"error": "Name required"}), 400

    conn = None
    try:
        conn = get_db_connection()
        execute(conn,
            "UPDATE chat_names SET name = %s WHERE chat_id = %s AND user_id = %s",
            (encrypt_text(new_name), chat_id, user_id),
            commit=True
        )
    finally:
        if conn:
            conn.close()

    return jsonify({"success": True})


@app.route("/user/profile", methods=["GET"])
def get_user_profile():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = None
    try:
        conn = get_db_connection()
        user = fetchone_dict(conn,
            "SELECT id, first_name, last_name, email, api_key, role, country, created_at FROM users WHERE id = %s",
            (user_id,)
        )
    finally:
        if conn:
            conn.close()

    if not user:
        return jsonify({"error": "User not found"}), 404

    user_dict = dict(user)
    user_dict["api_key"] = decrypt_text(user_dict.get("api_key", ""))
    return jsonify(user_dict)


@app.route("/user/profile", methods=["POST"])
def update_user_profile():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    first_name = data.get("first_name", "").strip()
    last_name = data.get("last_name", "").strip()
    email = data.get("email", "").strip()
    api_key = data.get("api_key", "").strip()
    country = data.get("country", "").strip()

    if not first_name or not last_name or not email:
        return jsonify({"error": "Missing required fields"}), 400

    conn = None
    try:
        conn = get_db_connection()
        execute(conn,
            """
            UPDATE users SET first_name = %s, last_name = %s, email = %s, api_key = %s, country = %s
            WHERE id = %s
            """,
            (first_name, last_name, email, encrypt_text(api_key), country, user_id),
            commit=True
        )
    except psycopg2.errors.UniqueViolation:
        if conn:
            conn.rollback()
        return jsonify({"error": "Email already exists"}), 400
    except Exception as e:
        if conn:
            conn.rollback()
        print("update_user_profile error:", e)
        return jsonify({"error": "Database error"}), 500
    finally:
        if conn:
            conn.close()

    return jsonify({"success": True})


# ---------------------
# Deck visualizer route
# ---------------------
@app.route("/deck/parse", methods=["POST"])
def parse_deck():
    """Parse protocol code and return visualization state JSON."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    code = data.get("code", "")
    context = data.get("context", "")
    chat_id = data.get("chat_id", "")
    if not code:
        return jsonify({"error": "No code provided"}), 400

    # Get user API key for LLM fallback
    user_api_key = None
    conn = None
    try:
        conn = get_db_connection()
        user = fetchone_dict(conn, "SELECT api_key FROM users WHERE id = %s", (user_id,))
        if user and user.get("api_key"):
            user_api_key = decrypt_text(user["api_key"])
    except Exception:
        pass
    finally:
        if conn:
            conn.close()

    from deck_parser import parse_any
    try:
        state = parse_any(code, context=context, api_key=user_api_key)

        # Save to DB if we have a chat_id
        if chat_id and not state.get("error"):
            _save_deck_state(chat_id, state)

        return jsonify(state)
    except Exception as e:
        return jsonify({"error": f"Parse error: {str(e)}"}), 400


@app.route("/deck/state/<chat_id>", methods=["GET"])
def get_deck_state(chat_id):
    """Retrieve saved deck state for a chat."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = None
    try:
        conn = get_db_connection()
        # Verify chat belongs to user
        chat = fetchone_dict(conn,
            "SELECT 1 FROM chat_names WHERE chat_id = %s AND user_id = %s",
            (chat_id, user_id))
        if not chat:
            return jsonify({"error": "Chat not found"}), 404

        row = fetchone_dict(conn,
            "SELECT deck_state FROM deck_states WHERE chat_id = %s",
            (chat_id,))
    finally:
        if conn:
            conn.close()

    if row and row.get("deck_state"):
        import json
        try:
            return jsonify(json.loads(row["deck_state"]))
        except Exception:
            return jsonify({"error": "Corrupt deck state"}), 500

    return jsonify({"error": "No saved deck state"}), 404


@app.route("/deck/state/<chat_id>", methods=["POST"])
def save_deck_state_route(chat_id):
    """Save/update deck state for a chat."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400

    _save_deck_state(chat_id, data)
    return jsonify({"success": True})


def _save_deck_state(chat_id, state):
    """Helper to upsert deck state in DB."""
    import json
    conn = None
    try:
        conn = get_db_connection()
        execute(conn,
            """INSERT INTO deck_states (chat_id, deck_state, created_at)
               VALUES (%s, %s, NOW())
               ON CONFLICT (chat_id)
               DO UPDATE SET deck_state = EXCLUDED.deck_state, created_at = NOW()""",
            (chat_id, json.dumps(state)),
            commit=True)
    except Exception as e:
        if conn:
            conn.rollback()
        print(f"Save deck state error: {e}")
    finally:
        if conn:
            conn.close()


@app.route("/deck/generate", methods=["POST"])
def generate_deck_code():
    """Update code based on deck changes."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    from deck_parser import update_slots_in_code

    original_code = data.get("original_code", "")
    slot_changes = data.get("slot_changes", {})

    try:
        if original_code and slot_changes:
            code = update_slots_in_code(original_code, slot_changes)
        else:
            code = original_code
        return jsonify({"code": code})
    except Exception as e:
        return jsonify({"error": f"Generate error: {str(e)}"}), 400


@app.route("/code/approve", methods=["POST"])
def approve_code():
    """
    Save user-verified working code into the documentation folder.
    This code becomes part of the RAG index on next rebuild, improving
    future protocol generation.
    """
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    code = data.get("code", "").strip()
    chat_id = data.get("chat_id", "")

    if not code:
        return jsonify({"error": "No code provided"}), 400

    from deck_parser import detect_platform
    import hashlib

    # Detect which platform this code is for
    platform = detect_platform(code)

    # Map platform to docs folder
    platform_folders = {
        "opentrons_ot2": "docs/opentrons/codes",
        "hamilton_star": "docs/hamilton/codes",
        "echo_650": "docs/echo/codes",
    }

    folder = platform_folders.get(platform, f"docs/{platform}/codes")

    # Create folder if it doesn't exist
    os.makedirs(folder, exist_ok=True)

    # Generate a unique filename from a hash of the code
    code_hash = hashlib.sha256(code.encode()).hexdigest()[:12]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Get user info for the file header
    conn = None
    username = "anonymous"
    try:
        conn = get_db_connection()
        user = fetchone_dict(conn,
            "SELECT first_name, last_name FROM users WHERE id = %s", (user_id,))
        if user:
            username = f"{user.get('first_name', '')} {user.get('last_name', '')}".strip()
    finally:
        if conn:
            conn.close()

    # Determine file extension
    ext = ".py"
    if platform == "echo_650":
        ext = ".csv"

    filename = f"verified_{timestamp}_{code_hash}{ext}"
    filepath = os.path.join(folder, filename)

    # Write the file with a header comment
    header = f"""# Verified working protocol
# Platform: {platform}
# Date: {datetime.now().isoformat()}
# Chat: {chat_id}
# ---
"""
    if ext == ".csv":
        # CSV files don't use Python comments
        header = ""

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(header + code)

    # Invalidate the RAG cache for this platform so the new code gets indexed
    _invalidate_rag_cache(platform)

    return jsonify({"success": True, "platform": platform, "file": filename})


def _invalidate_rag_cache(platform):
    """Delete the cached RAG pickle file so the index rebuilds with new docs."""
    import json

    # Check handlers.json for the store_path
    handlers_path = "handlers.json"
    if os.path.exists(handlers_path):
        try:
            with open(handlers_path) as f:
                handlers = json.load(f)
            for handler in handlers.values() if isinstance(handlers, dict) else handlers:
                h = handler if isinstance(handler, dict) else {}
                if h.get("name", "").lower() in platform.lower() or \
                   platform in h.get("keywords", []):
                    store = h.get("store_path", "")
                    if store and os.path.exists(store):
                        os.remove(store)
                        print(f"Invalidated RAG cache: {store}")
                    return
        except Exception as e:
            print(f"Cache invalidation error: {e}")

    # Fallback: try common store paths
    common_stores = {
        "opentrons_ot2": "rag_store.pkl",
        "hamilton_star": "rag_store_hamilton.pkl",
        "echo_650": "rag_store_echo.pkl",
    }
    store = common_stores.get(platform)
    if store and os.path.exists(store):
        os.remove(store)
        print(f"Invalidated RAG cache: {store}")
        
        
 

@app.route("/code/reject", methods=["POST"])
def reject_code():
    """Save user-reported failed code with their remark into the docs folder."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
 
    data = request.get_json()
    code = data.get("code", "").strip()
    remark = data.get("remark", "").strip()
    chat_id = data.get("chat_id", "")
 
    if not code or not remark:
        return jsonify({"error": "Code and remark are required"}), 400
 
    from deck_parser import detect_platform
    import hashlib
 
    platform = detect_platform(code)
    code_hash = hashlib.sha256(code.encode()).hexdigest()[:12]
 
    platform_folders = {
        "opentrons_ot2": "docs/opentrons/failed_codes",
        "hamilton_star": "docs/hamilton/failed_codes",
        "echo_650": "docs/echo/failed_codes",
    }
 
    folder = platform_folders.get(platform, f"docs/{platform}/failed_codes")
    os.makedirs(folder, exist_ok=True)
 
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
 
    conn = None
    username = "anonymous"
    try:
        conn = get_db_connection()
        user = fetchone_dict(conn,
            "SELECT first_name, last_name FROM users WHERE id = %s", (user_id,))
        if user:
            username = f"{user.get('first_name', '')} {user.get('last_name', '')}".strip()
    finally:
        if conn:
            conn.close()
 
    ext = ".csv" if platform == "echo_650" else ".py"
    filename = f"failed_{timestamp}_{code_hash}{ext}"
    filepath = os.path.join(folder, filename)
 
    header = f"""# FAILED PROTOCOL — DO NOT USE AS A WORKING EXAMPLE
# Platform: {platform}
# Date: {datetime.now().isoformat()}
# Chat: {chat_id}
#
# USER REMARK:
# {remark.replace(chr(10), chr(10) + '# ')}
#
# The code below did NOT work on the user's machine.
# Use this as a negative example to avoid generating similar errors.
# ---
"""
    if ext == ".csv":
        header = f"# FAILED — {remark}\n"
 
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(header + code)
 
    _invalidate_rag_cache(platform)
 
    return jsonify({"success": True, "platform": platform, "file": filename})
 
 
def _invalidate_rag_cache(platform):
    """Delete the cached RAG pickle file so the index rebuilds with new docs."""
    import json
 
    # Check handlers.json for the store_path
    handlers_path = "handlers.json"
    if os.path.exists(handlers_path):
        try:
            with open(handlers_path) as f:
                handlers = json.load(f)
            for handler in handlers.values() if isinstance(handlers, dict) else handlers:
                h = handler if isinstance(handler, dict) else {}
                if h.get("name", "").lower() in platform.lower() or \
                   platform in h.get("keywords", []):
                    store = h.get("store_path", "")
                    if store and os.path.exists(store):
                        os.remove(store)
                        print(f"Invalidated RAG cache: {store}")
                    return
        except Exception as e:
            print(f"Cache invalidation error: {e}")
 
    # Fallback: try common store paths
    common_stores = {
        "opentrons_ot2": "rag_store.pkl",
        "hamilton_star": "rag_store_hamilton.pkl",
        "echo_650": "rag_store_echo.pkl",
    }
    store = common_stores.get(platform)
    if store and os.path.exists(store):
        os.remove(store)
        print(f"Invalidated RAG cache: {store}")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)