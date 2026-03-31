__version__ = "1.0.0"

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

def encrypt_text(text):
    """Encrypt text if encryption key is available, otherwise return as-is."""
    key = get_encryption_key()
    if key and text:
        return encrypt(text, key)
    return text

def decrypt_text(ciphertext):
    """Decrypt text if encryption key is available, otherwise return as-is."""
    key = get_encryption_key()
    if key and ciphertext:
        try:
            return decrypt(ciphertext, key)
        except Exception:
            # Fallback for unencrypted legacy data
            return ciphertext
    return ciphertext

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
- If the user asks for code for protocols, generate clean, error-free Python code for operating lab robots.
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
            # Derive encryption key from password + stored salt
            if user.get("encryption_salt"):
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

        intro_message = "Hello, I'm Biobot 🤖 — your assistant specialized in lab automation..."
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

    # Decrypt history for the LLM
    messages = [{"role": r["role"], "content": decrypt_text(r["content"])} for r in rows]
    user_api_key = decrypt_text(user["api_key"]) if user and user.get("api_key") else None

    # Validate API key before starting the stream
    if not user_api_key:
        return Response("I don't have a valid API key configured. Please add your OpenAI API key in Settings.", mimetype="text/plain")

    # Capture encryption key before entering generator (session may not be available later)
    enc_key = get_encryption_key()

    # ---- STREAM RESPONSE ----
    def generate():
        full_reply = ""
        is_rag = False

        from engine import RAG_STATUS_PREFIX, FAILED_CODE_MARKER
        
        try:
            result = process_user_query(user_message, messages, MODEL_NAME, api_key=user_api_key)
            if result is None:
                yield "Sorry, I couldn't process your request. Please try again."
                return
            for chunk in result:
                if chunk.startswith(RAG_STATUS_PREFIX):
                    is_rag = True
                    status_text = chunk[len(RAG_STATUS_PREFIX):]
                    yield "__STATUS__:" + status_text
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
            # Before saving: wrap RAG code in markdown fences so it renders
            # correctly when reloaded from chat history
            save_content = full_reply
            if is_rag and full_reply:
                if full_reply.startswith(FAILED_CODE_MARKER):
                    failed_content = full_reply[len(FAILED_CODE_MARKER):]
                    sep_parts = failed_content.split("___CODE_SEP___", 1)
                    message = sep_parts[0].strip() if sep_parts else ""
                    code = sep_parts[1].strip() if len(sep_parts) > 1 else ""
                    save_content = message + "\n\n```python\n" + code + "\n```" if code else message
                else:
                    save_content = "```python\n" + full_reply + "\n```"

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

    return Response(stream_with_context(generate()), mimetype="text/plain")


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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)