__version__ = "1.5.2"

from flask import Flask, request, jsonify, render_template, redirect, url_for, session, flash, Response, stream_with_context
import uuid
import time
import os
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash

import psycopg2
import psycopg2.extras
import psycopg2.errors

from engine import process_user_query, dispatch_device, DeviceIncomplete
from config import get_api_key, get_db_connection, biobot_model, get_flask_secret_key
from crypt import generate_salt, derive_key, encrypt, decrypt
from handlers import detect_handler, load_handlers_config

# ---------------------
# App & DB init
# ---------------------
app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = os.environ.get("BIOBOT_DEV") == "1"
app.secret_key = get_flask_secret_key()
app.config["SESSION_PERMANENT"] = True
app.config["PERMANENT_SESSION_LIFETIME"] = 86400  # 24 hours in seconds

# ---------------------
# Encryption helpers
# ---------------------
def get_encryption_key():
    """Retrieve the user's encryption key from the session (for API keys only)."""
    key = session.get("encryption_key")
    if key:
        return key.encode("utf-8") if isinstance(key, str) else key
    return None


def _get_server_key():
    """Derive a stable encryption key from FLASK_SECRET_KEY (for chat messages).
    This key never changes, so messages survive password resets."""
    if not hasattr(_get_server_key, "_cached"):
        from crypt import derive_key
        # Use a fixed salt derived from the secret key itself
        import hashlib
        salt = hashlib.sha256(app.secret_key.encode()).hexdigest()[:32]
        _get_server_key._cached = derive_key(app.secret_key, salt)
    return _get_server_key._cached


def _is_encrypted(text):
    """Check if a string looks like Fernet ciphertext."""
    if not text or not isinstance(text, str):
        return False
    return text.startswith("gAAAAAB")


def encrypt_text(text):
    """Encrypt text using the user's session key (for API keys)."""
    key = get_encryption_key()
    if key and text:
        return encrypt(text, key)
    return text


def decrypt_text(ciphertext):
    """
    Decrypt text using the session encryption key. (for API key.)
    - If content is encrypted and key is available → decrypt normally
    - If content is encrypted but key is missing → return None (caller must handle)
    - If content is NOT encrypted (legacy plaintext) → return as-is
    """
    if not ciphertext:
        return ciphertext
    if not _is_encrypted(ciphertext):
        return ciphertext
    key = get_encryption_key()
    if not key:
        return None
    try:
        return decrypt(ciphertext, key)
    except Exception:
        return None


def encrypt_message(text):
    """Encrypt a chat message using the server key (survives password resets)."""
    if text:
        return encrypt(text, _get_server_key())
    return text


def decrypt_message(ciphertext):
    """
    Decrypt a chat message. Tries server key first, then user key (migration),
    then returns the raw text as fallback.
    """
    if not ciphertext:
        return ciphertext
    if not _is_encrypted(ciphertext):
        return ciphertext

    # Try server key first (new messages)
    try:
        return decrypt(ciphertext, _get_server_key())
    except Exception:
        pass

    # Try user key (old messages encrypted before this change)
    user_key = get_encryption_key()
    if user_key:
        try:
            return decrypt(ciphertext, user_key)
        except Exception:
            pass

    return "[Message encrypted with a previous password]"

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
- Do not answer queries that have nohing to do with your specialization which is lab automation, liquid handlers and other related fields. DECLINE KINDLY NO MATTER WHAT."""
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
        api_key = request.form.get("api_key", "").strip() or get_api_key(required=False)
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
            session["answer_session"] = uuid.uuid4().hex

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
    session.pop("answer_session", None)
    flash("You have been logged out.", "info")
    return redirect(url_for("login"))


# ---------------------
# Password Reset
# ---------------------
@app.route("/forgot-password", methods=["GET", "POST"])
def forgot_password():
    if request.method == "GET":
        return render_template("forgot_password.html")

    email = request.form.get("email", "").strip()
    if not email:
        flash("Please enter your email address.", "error")
        return redirect("/forgot-password")

    conn = None
    try:
        conn = get_db_connection()
        user = fetchone_dict(conn, "SELECT id, first_name FROM users WHERE email = %s", (email,))

        if user:
            import secrets
            from datetime import timedelta
            token = secrets.token_urlsafe(48)
            expires = datetime.now() + timedelta(hours=1)

            execute(conn,
                "DELETE FROM password_reset_tokens WHERE user_id = %s AND used = FALSE",
                (user["id"],), commit=True)

            execute(conn,
                "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (%s, %s, %s)",
                (user["id"], token, expires), commit=True)

            try:
                from email_service import send_password_reset_email, is_email_configured
                if is_email_configured():
                    reset_url = request.host_url.rstrip("/") + f"/reset-password/{token}"
                    send_password_reset_email(email, reset_url, user.get("first_name", ""))
                else:
                    print(f"SMTP not configured. Reset token for {email}: {token}")
            except Exception as e:
                print(f"Email send error: {e}")

    except Exception as e:
        print(f"Forgot password error: {e}")
    finally:
        if conn:
            conn.close()

    flash("If an account with that email exists, we've sent a password reset link.", "success")
    return redirect("/forgot-password")


@app.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token):
    conn = None
    try:
        conn = get_db_connection()
        row = fetchone_dict(conn,
            """SELECT t.id, t.user_id, t.expires_at, t.used, u.email
               FROM password_reset_tokens t
               JOIN users u ON t.user_id = u.id
               WHERE t.token = %s""",
            (token,))
    finally:
        if conn:
            conn.close()

    if not row:
        flash("Invalid or expired reset link.", "error")
        return redirect("/forgot-password")
    if row["used"]:
        flash("This reset link has already been used.", "error")
        return redirect("/forgot-password")
    if row["expires_at"] < datetime.now():
        flash("This reset link has expired. Please request a new one.", "error")
        return redirect("/forgot-password")

    if request.method == "GET":
        return render_template("reset_password.html", token=token)

    new_password = request.form.get("password", "")
    confirm_password = request.form.get("confirm_password", "")

    if not new_password or len(new_password) < 6:
        flash("Password must be at least 6 characters.", "error")
        return redirect(f"/reset-password/{token}")
    if new_password != confirm_password:
        flash("Passwords do not match.", "error")
        return redirect(f"/reset-password/{token}")

    conn = None
    try:
        conn = get_db_connection()
        new_hash = generate_password_hash(new_password)

        # Re-encrypt the default API key with the new password
        new_salt = generate_salt()
        new_enc_key = derive_key(new_password, new_salt)
        default_api_key = get_api_key(required=False)
        encrypted_default = encrypt(default_api_key, new_enc_key)

        execute(conn,
            "UPDATE users SET password = %s, api_key = %s, encryption_salt = %s WHERE id = %s",
            (new_hash, encrypted_default, new_salt, row["user_id"]),
            commit=True)

        execute(conn,
            "UPDATE password_reset_tokens SET used = TRUE WHERE id = %s",
            (row["id"],), commit=True)
    except Exception as e:
        if conn:
            conn.rollback()
        print(f"Password reset error: {e}")
        flash("An error occurred. Please try again.", "error")
        return redirect(f"/reset-password/{token}")
    finally:
        if conn:
            conn.close()

    flash("Password reset successful! You can now log in with your new password.", "success")
    return redirect("/login")


# ---------------------
# Main routes
# ---------------------
def is_owner(email):
    """Server owners, listed by email in BIOBOT_ADMINS (comma-separated), are admins and approve the others."""
    owners = {item.strip().casefold() for item in os.environ.get("BIOBOT_ADMINS", "").split(",") if item.strip()}
    return isinstance(email, str) and email.strip().casefold() in owners


def is_admin(user):
    return bool(user) and (is_owner(user.get("email")) or user.get("admin_status") == "approved")


def _admin_or_403():
    """The signed-in user's id if they are an admin, else None."""
    user_id = session.get("user")
    return user_id if user_id and _user_is_admin(user_id) else None


@app.route("/admin/request", methods=["POST"])
def request_admin():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    conn = get_db_connection()
    try:
        execute(conn, "UPDATE users SET admin_status = 'requested' WHERE id = %s AND admin_status IS NULL", (user_id,), commit=True)
    finally:
        conn.close()
    return jsonify({"status": "requested"})


@app.route("/admin/devices", methods=["GET"])
def admin_devices():
    if not _admin_or_403():
        return jsonify({"error": "Admins only"}), 403
    conn = get_db_connection()
    try:
        rows = fetchall_dict(conn, "SELECT device_id, device_name, layout ? 'sources' AS sourced FROM deck_templates WHERE is_default ORDER BY device_name")
    finally:
        conn.close()
    return jsonify([dict(row) for row in rows])


@app.route("/admin/devices/<device_id>/regenerate", methods=["POST"])
def admin_regenerate_device(device_id):
    user_id = _admin_or_403()
    if not user_id:
        return jsonify({"error": "Admins only"}), 403
    from deck_library import regenerate_default_deck
    try:
        api_key, _ = _deck_request_context({}, user_id)
        return jsonify({"device": regenerate_default_deck(device_id, api_key)})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        app.logger.exception("Device layout regeneration failed")
        return jsonify({"error": "Could not regenerate this device's layout. Please try again."}), 502


@app.route("/admin/requests", methods=["GET"])
def admin_requests():
    if not _admin_or_403():
        return jsonify({"error": "Admins only"}), 403
    conn = get_db_connection()
    try:
        rows = fetchall_dict(conn, "SELECT id, first_name, last_name, email FROM users WHERE admin_status = 'requested' ORDER BY id")
    finally:
        conn.close()
    return jsonify([dict(row) for row in rows])


@app.route("/admin/requests/<int:target>", methods=["POST"])
def decide_admin_request(target):
    if not _admin_or_403():
        return jsonify({"error": "Admins only"}), 403
    approve = (request.get_json(silent=True) or {}).get("approve") is True
    conn = get_db_connection()
    try:
        execute(conn, "UPDATE users SET admin_status = %s WHERE id = %s AND admin_status = 'requested'",
                ("approved" if approve else None, target), commit=True)
    finally:
        conn.close()
    return jsonify({"status": "approved" if approve else "rejected"})


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

    session.setdefault("answer_session", uuid.uuid4().hex)
    return render_template("index.html", user=user, version=__version__, is_admin=is_admin(user))


@app.route("/chat", methods=["POST"])
def create_chat():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    chat_id = str(uuid.uuid4())
    title = "New chat"
    data = request.get_json(silent=True) or {}
    device = data.get("device", "")
    if not isinstance(device, str) or len(device) > 200:
        return jsonify({"error": "Invalid device."}), 400
    device = device.strip()

    conn = None
    try:
        conn = get_db_connection()
        source = None
        protocol_id = data.get("protocol_id")
        if protocol_id:
            try:
                protocol_id = str(uuid.UUID(str(protocol_id)))
            except ValueError:
                return jsonify({"error": "Protocol not found"}), 404
            source = fetchone_dict(conn, "SELECT name, code, device_name FROM saved_protocols WHERE id = %s AND user_id = %s AND deleted_at IS NULL", (protocol_id, user_id))
            if not source:
                return jsonify({"error": "Protocol not found"}), 404
            title = decrypt_message(source["name"])
        execute(conn,
            "INSERT INTO chat_names (chat_id, user_id, name, device_name) VALUES (%s, %s, %s, %s)",
            (chat_id, user_id, encrypt_message(title), device or None),
            commit=True
        )

        system_message = SYSTEM_PROMPT["content"]
        execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content) VALUES (%s, %s, %s, %s)",
            (user_id, chat_id, "system", encrypt_message(system_message)),
            commit=True
        )

        intro_message = "Hello, I'm Biobot 🤖 — your assistant specialized in lab automation."
        if device:
            intro_message += f"\nSelected device: {device}. Use it as context unless the user specifies another device."
        if source:
            execute(conn, "UPDATE chat_names SET device_name = %s WHERE chat_id = %s", (source["device_name"], chat_id))
            intro_message = f"Saved protocol for {source['device_name']}:\n```\n{decrypt_message(source['code'])}\n```"
        execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content) VALUES (%s, %s, %s, %s)",
            (user_id, chat_id, "assistant", encrypt_message(intro_message)),
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
            "SELECT 1 FROM chat_names WHERE chat_id = %s AND user_id = %s AND deleted_at IS NULL",
            (chat_id, user_id)
        )
        if not chat_exists:
            return jsonify({"error": "Chat not found"}), 404

        # insert user message (encrypted)
        execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (%s, %s, %s, %s, %s)",
            (user_id, chat_id, "user", encrypt_message(user_message), datetime.now().isoformat()),
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
    messages = [{"role": r["role"], "content": decrypt_message(r["content"])} for r in rows]

    # call your engine
    bot_reply = process_user_query(user_message, messages, biobot_model, api_key=user_api_key)

    # save bot response (encrypted)
    conn = None
    try:
        conn = get_db_connection()
        execute(conn,
            "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (%s, %s, %s, %s, %s)",
            (user_id, chat_id, "assistant", encrypt_message(bot_reply), datetime.now().isoformat()),
            commit=True
        )

        # rename chat if still "New chat"
        title_row = fetchone_dict(conn, "SELECT name FROM chat_names WHERE chat_id = %s AND user_id = %s", (chat_id, user_id))
        if title_row and decrypt_message(title_row.get("name")) == "New chat":
            preview_words = user_message.strip().split()
            preview = " ".join(preview_words[:5])
            if len(preview_words) > 5:
                preview += "..."
            execute(conn,
                "UPDATE chat_names SET name = %s WHERE chat_id = %s AND user_id = %s",
                (encrypt_message(preview), chat_id, user_id),
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

def chat_run_response(chat_id, user_id, run_id, message_id):
    def replay():
        offset = 0
        while True:
            conn = get_db_connection()
            try:
                run = fetchone_dict(conn, "SELECT output, status FROM chat_runs WHERE chat_id = %s AND user_id = %s AND id = %s", (chat_id, user_id, run_id))
            finally:
                conn.close()
            if not run:
                return
            output = decrypt_message(run["output"]) or ""
            if len(output) > offset:
                yield output[offset:]
                offset = len(output)
            if run["status"] != "running":
                return
            time.sleep(0.15)
    return Response(stream_with_context(replay()), mimetype="text/plain", headers={
        "X-User-Message-Id": str(message_id), "X-Chat-Run-Id": str(run_id),
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    })


@app.route("/chat/<chat_id>/stream", methods=["GET"])
def reconnect_chat_stream(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    conn = get_db_connection()
    try:
        run = fetchone_dict(conn, """SELECT r.id::text, r.message_id FROM chat_runs r JOIN chat_names c USING (chat_id)
            WHERE r.chat_id = %s AND r.user_id = %s AND c.deleted_at IS NULL""", (chat_id, user_id))
    finally:
        conn.close()
    if not run:
        return jsonify({"error": "No saved response for this chat."}), 404
    return chat_run_response(chat_id, user_id, run["id"], run["message_id"])


@app.route("/chat/<chat_id>/read", methods=["POST"])
def mark_chat_read(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    conn = get_db_connection()
    try:
        execute(conn, "UPDATE chat_runs SET seen = TRUE WHERE chat_id = %s AND user_id = %s AND status <> 'running'", (chat_id, user_id), commit=True)
    finally:
        conn.close()
    return jsonify({"success": True})


#For streaming :
@app.route("/chat/<chat_id>/stream", methods=["POST"])
def chat_stream(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json(silent=True) or {}
    user_message = data.get("message")
    if not isinstance(user_message, str) or not user_message.strip():
        return jsonify({"error": "Message required"}), 400
    user_message = user_message.strip()
    deck_layout = data.get("deck_layout")
    debug_logs = data.get("debug") is True and _user_is_admin(user_id)
    if deck_layout is not None:
        from deck_library import clean_layout
        try:
            deck_layout = clean_layout(deck_layout)
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid deck layout"}), 400
    device = data.get("device", "")
    if not isinstance(device, str) or len(device) > 200:
        return jsonify({"error": "Invalid device."}), 400
    device = device.strip()
    edit_id = data.get("message_id")
    if edit_id is not None and (type(edit_id) is not int or edit_id <= 0):
        return jsonify({"error": "Invalid message ID"}), 400

    if not get_encryption_key():
        session.clear()
        return jsonify({"error": "Your session has expired. Please log in again."}), 401

    conn = None
    try:
        conn = get_db_connection()

        # verify chat exists
        chat_exists = fetchone_dict(conn,
            "SELECT 1 FROM chat_names WHERE chat_id = %s AND user_id = %s AND deleted_at IS NULL FOR UPDATE",
            (chat_id, user_id)
        )
        if not chat_exists:
            return jsonify({"error": "Chat not found"}), 404

        user = fetchone_dict(conn, "SELECT api_key FROM users WHERE id = %s", (user_id,))
        user_api_key = decrypt_text(user["api_key"]) if user and user.get("api_key") else None
        if not user_api_key or not user_api_key.startswith("sk-"):
            return jsonify({"error": "Please add a valid OpenAI API key in Settings."}), 400

        previous = fetchone_dict(conn, "SELECT status FROM chat_runs WHERE chat_id = %s AND user_id = %s", (chat_id, user_id))
        if previous and previous["status"] == "running":
            return jsonify({"error": "This chat is already working. Open it to follow its progress."}), 409
        run_id = str(uuid.uuid4())
        execute(conn, """INSERT INTO chat_runs (chat_id, id, user_id) VALUES (%s, %s, %s)
            ON CONFLICT (chat_id) DO UPDATE SET id = EXCLUDED.id, message_id = NULL, status = 'running', output = '', seen = FALSE, updated_at = NOW()""", (chat_id, run_id, user_id))

        if device:
            execute(conn, "UPDATE chat_names SET device_name = %s WHERE chat_id = %s AND user_id = %s", (device, chat_id, user_id))
            # Each request on a device also checks online for new or changed documentation (background, next requests benefit).
            from documentation_index import preload_documentation
            preload_documentation(device, user_api_key)

        encrypted_prompt = encrypt_message(user_message)
        if edit_id is not None:
            target = fetchone_dict(conn,
                "SELECT id FROM chat_history WHERE id = %s AND chat_id = %s AND user_id = %s AND role = 'user' FOR UPDATE",
                (edit_id, chat_id, user_id))
            if not target:
                return jsonify({"error": "Message not found"}), 404
            execute(conn,
                "UPDATE chat_history SET content = %s WHERE id = %s AND chat_id = %s AND user_id = %s",
                (encrypted_prompt, edit_id, chat_id, user_id))
            execute(conn,
                "DELETE FROM chat_history WHERE chat_id = %s AND user_id = %s AND id > %s",
                (chat_id, user_id, edit_id))
            message_id = edit_id
            conn.commit()
        else:
            row = execute(conn,
                "INSERT INTO chat_history (user_id, chat_id, role, content) VALUES (%s, %s, 'user', %s) RETURNING id",
                (user_id, chat_id, encrypted_prompt), commit=True, returning=True)
            message_id = row["id"]

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
                (user_id, chat_id, "assistant", encrypt_message(intro_message), datetime.now().isoformat()),
                commit=True
            )

        execute(conn, "UPDATE chat_runs SET message_id = %s WHERE chat_id = %s AND id = %s", (message_id, chat_id, run_id), commit=True)

        # fetch full chat history for streaming
        rows = fetchall_dict(conn,
            """
            SELECT role, content
            FROM chat_history
            WHERE user_id = %s AND chat_id = %s
            ORDER BY id
            """,
            (user_id, chat_id)
        )

    finally:
        if conn:
            conn.close()

    messages = [{"role": r["role"], "content": decrypt_message(r["content"])} for r in rows]
    if device:
        messages.insert(max(0, len(messages) - 1), {"role": "assistant", "content": f"Selected device context: {device}. Use it unless the user's prompt specifies another device."})
    if deck_layout is not None:
        import json
        messages.insert(max(0, len(messages) - 1), {"role": "assistant", "content": "The user selected this physical deck configuration. Preserve its hardware and positions when generating the protocol: " + json.dumps(deck_layout)})

    # ---- STREAM RESPONSE ----
    def generate():
        full_reply = ""
        is_rag = False
        detected_format = "text"

        from engine import RAG_STATUS_PREFIX, FAILED_CODE_MARKER, FORMAT_MARKER
        
        try:
            result = process_user_query(user_message, messages, biobot_model, api_key=user_api_key, debug=debug_logs)
            if result is None:
                raise RuntimeError("Couldn't process your request. Please try again.")
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
            if not full_reply.strip():
                raise RuntimeError("No answer was returned. Please retry your request.")
        except Exception as e:
            import sys
            print(f"Stream error: {e}", file=sys.stderr, flush=True)
            error_msg = str(e).lower()
            if "auth" in error_msg or "api key" in error_msg or "401" in error_msg or "403" in error_msg:
                reply = "Your API key appears to be invalid or expired. Please update it in Settings."
            elif "credit_balance_exhausted" in error_msg:
                reply = "Your OpenAI API account has no credits remaining. Add credits in OpenAI billing, or use another API key in Settings."
            elif any(code in error_msg for code in ("insufficient_quota", "spend_limit_exceeded", "usage_limit_exceeded")):
                reply = "Your OpenAI API account has reached its billing or usage limit. Check your OpenAI billing and limits, or use another API key in Settings."
            elif "rate limit" in error_msg or "429" in error_msg:
                reply = "Rate limit reached. Please wait a moment and try again."
            elif "timeout" in error_msg or "timed out" in error_msg:
                reply = "The request timed out while preparing the protocol. Please retry your request."
            elif "model" in error_msg or "404" in error_msg:
                reply = "The AI model is currently unavailable. Please try again later."
            else:
                reply = f"An error occurred: {str(e)}"
            # A failed generation is a chat answer too: show it and keep it in history.
            full_reply = FAILED_CODE_MARKER + reply
            is_rag = False
            detected_format = "text"
            yield full_reply

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
                        fmt = detected_format
                        save_content = message + f"\n\n```{fmt}\n" + code + "\n```"
                    else:
                        save_content = message

                elif _re.match(r'^```\w+\s*\n', full_reply):
                    # Content already has markdown fences — save as-is
                    save_content = full_reply

                elif is_rag:
                    # RAG output without fences — always wrap as code
                    fmt = detected_format
                    save_content = f"```{fmt}\n" + full_reply + "\n```"

                elif detected_format != "text":
                    # Non-RAG output with detected format — wrap it
                    save_content = f"```{detected_format}\n" + full_reply + "\n```"

                # else: normal text (general/out response) — save as-is

            # Encrypt before saving (using server key — survives password resets)
            encrypted_content = encrypt_message(save_content)

            # Save assistant message after streaming finishes
            conn2 = None
            try:
                conn2 = get_db_connection()
                execute(conn2,
                    """
                    INSERT INTO chat_history (user_id, chat_id, role, content, created_at)
                    SELECT %s, %s, %s, %s, %s
                    WHERE EXISTS (
                        SELECT 1 FROM chat_history h JOIN chat_names c
                          ON c.chat_id = h.chat_id AND c.user_id = h.user_id
                        WHERE h.id = %s AND h.chat_id = %s AND h.user_id = %s AND h.content = %s
                          AND c.deleted_at IS NULL
                    )
                    """,
                    (user_id, chat_id, "assistant", encrypted_content, datetime.now().isoformat(),
                     message_id, chat_id, user_id, encrypted_prompt),
                    commit=True
                )

                # RENAME CHAT if still "New chat"
                title_row = fetchone_dict(conn2,
                    "SELECT name FROM chat_names WHERE chat_id = %s AND user_id = %s",
                    (chat_id, user_id)
                )
                if title_row:
                    decrypted_name = decrypt_message(title_row["name"])
                    if decrypted_name == "New chat":
                        preview_words = user_message.strip().split()
                        preview = " ".join(preview_words[:5])
                        if len(preview_words) > 5:
                            preview += "..."
                        execute(conn2,
                            "UPDATE chat_names SET name = %s WHERE chat_id = %s AND user_id = %s",
                            (encrypt_message(preview), chat_id, user_id),
                            commit=True
                        )

            finally:
                if conn2:
                    conn2.close()

        except Exception as e:
            import sys
            print(f"Save error (response was delivered): {e}", file=sys.stderr, flush=True)
            raise RuntimeError("The completed response could not be saved.") from e

    # Generation belongs to the server task; disconnecting a browser only stops replay.
    def run_task():
        output, status, last_write = "", "done", 0
        def save(state):
            conn = get_db_connection()
            try:
                execute(conn, "UPDATE chat_runs SET output = %s, status = %s, updated_at = NOW() WHERE chat_id = %s AND id = %s",
                        (encrypt_message(output), state, chat_id, run_id), commit=True)
            finally:
                conn.close()
        with app.app_context():
            try:
                for chunk in generate():
                    output += chunk
                    if "__FAILED_CODE__:" in chunk:
                        status = "error"
                    if time.monotonic() - last_write >= 0.1:
                        save("running")
                        last_write = time.monotonic()
            except Exception as error:
                status = "error"
                output += "__FAILED_CODE__:The response could not be saved. Please retry."
                app.logger.exception("Chat task failed: %s", error)
            finally:
                save(status)
    from threading import Thread
    Thread(target=run_task, name=f"chat-{chat_id}", daemon=False).start()
    return chat_run_response(chat_id, user_id, run_id, message_id)


@app.route("/chat/<chat_id>", methods=["GET"])
def get_history(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = None
    try:
        conn = get_db_connection()
        if not fetchone_dict(conn, "SELECT 1 FROM chat_names WHERE chat_id = %s AND user_id = %s AND deleted_at IS NULL", (chat_id, user_id)):
            return jsonify({"error": "Chat not found"}), 404
        rows = fetchall_dict(conn,
            "SELECT id, role, content FROM chat_history WHERE user_id = %s AND chat_id = %s ORDER BY id",
            (user_id, chat_id)
        )
    finally:
        if conn:
            conn.close()

    visible_messages = [{"id": r["id"], "role": r["role"], "content": decrypt_message(r["content"])} for r in rows if r["role"] != "system"]
    return jsonify(visible_messages)


@app.route("/chat/<chat_id>", methods=["DELETE"])
def delete_chat(chat_id):
    """Move a conversation to Trash, preserving its messages for restoration."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    conn = get_db_connection()
    try:
        changed = execute(conn,
            "UPDATE chat_names SET deleted_at = COALESCE(deleted_at, NOW()) WHERE chat_id = %s AND user_id = %s RETURNING chat_id",
            (chat_id, user_id), commit=True, returning=True)
        if not changed:
            return jsonify({"error": "Chat not found"}), 404
    finally:
        conn.close()
    return jsonify({"success": True})


@app.route("/chat/<chat_id>/restore", methods=["POST"])
def restore_chat(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    conn = get_db_connection()
    try:
        changed = execute(conn,
            "UPDATE chat_names SET deleted_at = NULL WHERE chat_id = %s AND user_id = %s RETURNING chat_id",
            (chat_id, user_id), commit=True, returning=True)
        if not changed:
            return jsonify({"error": "Chat not found"}), 404
    finally:
        conn.close()
    return jsonify({"success": True})


@app.route("/chats", methods=["GET"])
def list_chats():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    predicate = "IS NOT NULL" if request.args.get("trashed") == "1" else "IS NULL"
    conn = get_db_connection()
    try:
        rows = fetchall_dict(conn, f"""SELECT chat_id, name, device_name, deleted_at,
            EXISTS (SELECT 1 FROM chat_history h WHERE h.chat_id = chat_names.chat_id AND h.role = 'user') AS has_messages
            FROM chat_names WHERE user_id = %s AND deleted_at {predicate}
            ORDER BY (SELECT MAX(id) FROM chat_history WHERE chat_id = chat_names.chat_id) DESC NULLS LAST""", (user_id,))
        runs = {row["chat_id"]: row for row in fetchall_dict(conn,
            "SELECT chat_id, id::text, message_id, status, seen FROM chat_runs WHERE user_id = %s", (user_id,))}
    finally:
        conn.close()
    return jsonify([{"chat_id": row["chat_id"], "name": decrypt_message(row["name"]), "device": row["device_name"], "run": runs.get(row["chat_id"]),
                     "has_messages": row["has_messages"], "deleted_at": row["deleted_at"].isoformat() if row["deleted_at"] else None} for row in rows])


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
            "UPDATE chat_names SET name = %s WHERE chat_id = %s AND user_id = %s AND deleted_at IS NULL",
            (encrypt_message(new_name), chat_id, user_id),
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
@app.route("/protocols", methods=["GET", "POST"])
def saved_protocols():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    data = request.get_json(silent=True) or {}
    if request.method == "POST":
        name, code, device = data.get("name"), data.get("code"), data.get("device", "")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            return jsonify({"error": "Give the protocol a name of up to 120 characters."}), 400
        if not isinstance(code, str) or not code.strip() or len(code) > 2_000_000:
            return jsonify({"error": "A completed protocol is required."}), 400
        if not isinstance(device, str) or len(device) > 200:
            return jsonify({"error": "Invalid device."}), 400
    conn = get_db_connection()
    try:
        if request.method == "GET":
            predicate = "IS NOT NULL" if request.args.get("trashed") == "1" else "IS NULL"
            rows = fetchall_dict(conn, f"SELECT id::text, name, device_name, created_at, deleted_at FROM saved_protocols WHERE user_id = %s AND deleted_at {predicate} ORDER BY created_at DESC", (user_id,))
            stamp = lambda value: value.isoformat() if hasattr(value, "isoformat") else value
            return jsonify([dict(row, name=decrypt_message(row["name"]), created_at=stamp(row["created_at"]), deleted_at=stamp(row["deleted_at"])) for row in rows])
        protocol_id = str(uuid.uuid4())
        execute(conn, "INSERT INTO saved_protocols (id, user_id, name, device_name, code) VALUES (%s, %s, %s, %s, %s)",
                (protocol_id, user_id, encrypt_message(name.strip()), device.strip(), encrypt_message(code)), commit=True)
        return jsonify({"id": protocol_id, "name": name.strip()}), 201
    finally:
        conn.close()


@app.route("/protocols/<uuid:protocol_id>", methods=["GET", "PATCH", "DELETE"])
def get_saved_protocol(protocol_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    if request.method == "PATCH":
        name = (request.get_json(silent=True) or {}).get("name")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            return jsonify({"error": "Give the protocol a name of up to 120 characters."}), 400
    conn = get_db_connection()
    try:
        row = fetchone_dict(conn, "SELECT id::text, name, device_name, code FROM saved_protocols WHERE id = %s AND user_id = %s AND deleted_at IS NULL", (str(protocol_id), user_id))
        if not row:
            return jsonify({"error": "Protocol not found"}), 404
        if request.method == "DELETE":
            execute(conn, "UPDATE saved_protocols SET deleted_at = NOW() WHERE id = %s AND user_id = %s", (str(protocol_id), user_id), commit=True)
            return jsonify({"success": True})
        if request.method == "PATCH":
            execute(conn, "UPDATE saved_protocols SET name = %s WHERE id = %s AND user_id = %s",
                    (encrypt_message(name.strip()), str(protocol_id), user_id), commit=True)
            return jsonify({"name": name.strip()})
        return jsonify(dict(row, name=decrypt_message(row["name"]), code=decrypt_message(row["code"])))
    finally:
        conn.close()


@app.route("/protocols/<uuid:protocol_id>/restore", methods=["POST"])
def restore_saved_protocol(protocol_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    conn = get_db_connection()
    try:
        row = fetchone_dict(conn, "UPDATE saved_protocols SET deleted_at = NULL WHERE id = %s AND user_id = %s RETURNING id", (str(protocol_id), user_id))
        conn.commit()
        if not row:
            return jsonify({"error": "Protocol not found"}), 404
        return jsonify({"success": True})
    finally:
        conn.close()


@app.route("/devices", methods=["GET"])
def used_devices():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    conn = get_db_connection()
    try:
        rows = fetchall_dict(conn, """SELECT device_name FROM chat_names WHERE user_id = %s AND device_name IS NOT NULL
                                     UNION SELECT device_name FROM saved_protocols WHERE user_id = %s AND device_name <> ''
                                     UNION SELECT t.device_name FROM deck_protocols p JOIN deck_templates t ON t.id = p.template_id
                                     WHERE p.user_id = %s ORDER BY device_name""", (user_id, user_id, user_id))
        return jsonify([row["device_name"] for row in rows])
    finally:
        conn.close()


@app.route("/devices/validate", methods=["POST"])
def validate_device():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    name = (request.get_json(silent=True) or {}).get("device")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 200:
        return jsonify({"error": "Enter a liquid handler name and model."}), 400
    try:
        api_key, _ = _deck_request_context({}, user_id)
        conn = get_db_connection()
        try:
            known = fetchall_dict(conn, "SELECT DISTINCT device_id, device_name AS name FROM deck_templates")
        finally:
            conn.close()
        device = dispatch_device(name.strip(), [dict(row) for row in known], api_key)
        session["validated_device"] = device
        return jsonify(device)
    except DeviceIncomplete as error:
        from engine import list_device_models
        return jsonify({"incomplete": True, "message": str(error), "options": list_device_models(error.query, api_key)})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        app.logger.exception("Device validation failed")
        return jsonify({"error": "Could not validate this device. Please try again."}), 502


@app.route("/chat/<chat_id>/device", methods=["POST"])
def select_device(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    data = request.get_json(silent=True) or {}
    name = data.get("device")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 200:
        return jsonify({"error": "Enter the device or model name."}), 400
    from deck_library import get_device_deck
    try:
        api_key, _ = _deck_request_context({"chat_id": chat_id}, user_id)
        validated = session.get("validated_device")
        if not isinstance(validated, dict) or validated.get("name") != name.strip():
            validated = None
        state = get_device_deck(name.strip(), user_id, api_key, data.get("template_id"), identified_device=validated)
        conn = get_db_connection()
        try:
            # Store device context with the chat so future prompts need not repeat it.
            previous = fetchone_dict(conn, "SELECT device_name FROM chat_names WHERE chat_id = %s AND user_id = %s AND deleted_at IS NULL", (chat_id, user_id))
            if not previous:
                return jsonify({"error": "Chat not found"}), 404
            if previous["device_name"] != state["platform"]:
                execute(conn, "UPDATE chat_names SET device_name = %s WHERE chat_id = %s AND user_id = %s", (state["platform"], chat_id, user_id))
                execute(conn, "INSERT INTO chat_history (user_id, chat_id, role, content) VALUES (%s, %s, 'assistant', %s)",
                        (user_id, chat_id, encrypt_message(f"Your {state['platform']} workspace is ready. What would you like to prepare?")), commit=True)
        finally:
            conn.close()
        from documentation_index import preload_documentation
        preload_documentation(state["platform"], api_key)
        return jsonify(state)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        app.logger.exception("Device deck failed")
        return jsonify({"error": "Could not open this device. Please try again."}), 502


def _deck_request_context(data, user_id):
    conn = get_db_connection()
    try:
        user = fetchone_dict(conn, "SELECT api_key FROM users WHERE id = %s", (user_id,))
        api_key = decrypt_text(user["api_key"]) if user and user.get("api_key") else None
        history = []
        chat_id = data.get("chat_id")
        if chat_id:
            if not fetchone_dict(conn, "SELECT 1 FROM chat_names WHERE chat_id = %s AND user_id = %s AND deleted_at IS NULL", (chat_id, user_id)):
                raise ValueError("Chat not found.")
            rows = fetchall_dict(conn, "SELECT role, content FROM chat_history WHERE chat_id = %s AND user_id = %s ORDER BY id", (chat_id, user_id))
            history = [{"role": row["role"], "content": decrypt_message(row["content"])} for row in rows]
        return api_key, history
    finally:
        conn.close()


@app.route("/deck/visualize", methods=["POST"])
def visualize_deck():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    data = request.get_json(silent=True) or {}
    code = data.get("code")
    if not isinstance(code, str) or not code.strip():
        return jsonify({"error": "No code provided"}), 400
    from deck_library import get_deck
    try:
        api_key, history = _deck_request_context(data, user_id)
        return jsonify(get_deck(code, user_id, api_key, history, data.get("template_id"), refresh_parameters=data.get("refresh_parameters") is True))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        app.logger.exception("Deck visualization failed")
        return jsonify({"error": "Could not load the deck. Please try again."}), 502


@app.route("/deck/update", methods=["POST"])
def update_deck():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    data = request.get_json(silent=True) or {}
    code, changes = data.get("code"), data.get("changes")
    if not isinstance(code, str) or not code.strip() or not isinstance(changes, list) or not changes:
        return jsonify({"error": "Missing code or changes"}), 400
    from deck_visualizer import update_code_from_changes
    from deck_library import get_deck
    try:
        api_key, history = _deck_request_context(data, user_id)
        import protocol_lang
        if protocol_lang.parse(code) and all(change.get("type") == "set_parameter" for change in changes):
            updated = protocol_lang.set_parameters(code, changes)
        else:
            updated = update_code_from_changes(code, changes, api_key)
        state = get_deck(updated, user_id, api_key, history, data.get("template_id"))
        if data.get("chat_id"):
            _save_deck_protocol(data["chat_id"], user_id, code, updated)
        return jsonify({"code": updated, "state": state})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        app.logger.exception("Deck update failed")
        return jsonify({"error": "Could not update the protocol. Please try again."}), 502


def _user_is_admin(user_id):
    conn = get_db_connection()
    try:
        user = fetchone_dict(conn, "SELECT email, admin_status FROM users WHERE id = %s", (user_id,))
    finally:
        conn.close()
    return is_admin(user)


_exports, _exports_lock = {}, __import__("threading").Lock()  # (user, protocol hash) -> export job


def _protocol_hash(protocol):
    """Same key for the same protocol, whatever its formatting."""
    import hashlib, json, protocol_lang
    parsed = protocol_lang.parse(protocol)
    text = json.dumps(parsed, sort_keys=True, ensure_ascii=False) if parsed else protocol.strip()
    return hashlib.sha256(text.encode()).hexdigest()


def _exports_table(conn):
    """Finished exports survive server restarts and chat switches."""
    execute(conn, """CREATE TABLE IF NOT EXISTS protocol_exports (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, protocol_hash TEXT NOT NULL, chat_id TEXT,
        code TEXT NOT NULL, format TEXT, warning TEXT, protocol TEXT NOT NULL, finished TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, protocol_hash))""", commit=True)


def _save_export(user_id, protocol_hash, job):
    conn = get_db_connection()
    try:
        _exports_table(conn)
        execute(conn, """INSERT INTO protocol_exports (user_id, protocol_hash, chat_id, code, format, warning, protocol)
                         VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (user_id, protocol_hash) DO UPDATE
                         SET chat_id = EXCLUDED.chat_id, code = EXCLUDED.code, format = EXCLUDED.format,
                             warning = EXCLUDED.warning, protocol = EXCLUDED.protocol, finished = NOW()""",
                (user_id, protocol_hash, job.get("chat_id"), encrypt_message(job["code"]), job.get("format"),
                 job.get("warning"), encrypt_message(job["protocol"])), commit=True)
    finally:
        conn.close()


def _saved_export(user_id, protocol_hash=None, chat_id=None):
    """A finished export: for this protocol, or the chat's latest one."""
    conn = get_db_connection()
    try:
        _exports_table(conn)
        row = fetchone_dict(conn, "SELECT * FROM protocol_exports WHERE user_id = %s AND protocol_hash = %s", (user_id, protocol_hash)) \
            if protocol_hash else fetchone_dict(conn, "SELECT * FROM protocol_exports WHERE user_id = %s AND chat_id = %s ORDER BY finished DESC LIMIT 1", (user_id, chat_id))
    finally:
        conn.close()
    return row and {"state": "done", "code": decrypt_message(row["code"]), "format": row["format"], "warning": row["warning"],
                    "chat_id": row["chat_id"], "protocol": decrypt_message(row["protocol"])}


def _run_export(key, job, protocol, api_key, history, debug=False):
    from engine import RAG_STATUS_PREFIX, FAILED_CODE_MARKER, FORMAT_MARKER
    try:
        chunks = []
        for chunk in process_user_query(protocol, history, biobot_model, api_key=api_key, export=True, debug=debug):
            if not chunk.startswith(RAG_STATUS_PREFIX):
                chunks.append(chunk)
            elif chunk[len(RAG_STATUS_PREFIX):].startswith("__WARNING__:"):
                job["warning"] = chunk[len(RAG_STATUS_PREFIX) + len("__WARNING__:"):].strip()
            elif not chunk[len(RAG_STATUS_PREFIX):].startswith("__"):
                job["step"] = chunk[len(RAG_STATUS_PREFIX):].strip()  # progress shown next to the spinner
        output = "".join(chunks)
        fmt, _, code = output[len(FORMAT_MARKER):].partition("\n")
        if not output.startswith(FORMAT_MARKER):
            job = {"state": "error", "error": "Could not identify the device for this protocol."}
        elif code.startswith(FAILED_CODE_MARKER):
            message, _, code = code[len(FAILED_CODE_MARKER):].partition("___CODE_SEP___")
            job = {"state": "error", "error": message.strip(), "code": code.strip(), "format": fmt}
        else:
            job = {"state": "done", "code": code.strip(), "format": fmt, "warning": job.get("warning"),
                   "chat_id": job.get("chat_id"), "protocol": protocol}
            _save_export(key[0], key[1], job)
    except Exception:
        app.logger.exception("Protocol export failed")
        job = {"state": "error", "error": "Could not export the protocol. Please try again."}
    with _exports_lock:
        _exports[key] = job


@app.route("/protocol/export", methods=["POST"])
def export_protocol():
    """Device code for the current protocol, generated in the background.
    start=true starts a job unless one is running or done; the reply is the job's state."""
    from threading import Thread
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    data = request.get_json(silent=True) or {}
    protocol = data.get("protocol")
    if not isinstance(protocol, str) or not protocol.strip():
        return jsonify({"error": "No protocol to export"}), 400
    debug = data.get("debug") is True and _user_is_admin(user_id)  # admins: keep the log even on success
    key = (user_id, _protocol_hash(protocol))
    with _exports_lock:
        job = _exports.get(key)
    if job is None and (saved := _saved_export(user_id, key[1])):
        with _exports_lock:
            job = _exports.setdefault(key, saved)
    with _exports_lock:
        job = _exports.get(key)
        if data.get("start") is True and (job is None or job["state"] == "error"):
            try:
                api_key, history = _deck_request_context(data, user_id)
            except ValueError as error:
                return jsonify({"error": str(error)}), 400
            job = _exports[key] = {"state": "running", "step": "Starting…", "chat_id": data.get("chat_id")}
            Thread(target=_run_export, args=(key, job, protocol, api_key, history, debug), name="export", daemon=True).start()
        reply = {k: v for k, v in (job or {"state": "none"}).items() if k != "protocol"}
    if reply["state"] != "done" and data.get("chat_id"):
        # The chat's last generated code, so the user can go back to its protocol.
        last = _saved_export(user_id, chat_id=data["chat_id"])
        if last:
            reply["previous"] = {"protocol": last["protocol"], "code": last["code"]}
    return jsonify(reply)


@app.route("/protocol/exports", methods=["GET"])
def running_exports():
    """Chats whose code is being generated, for the activity dots in the chat history."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    with _exports_lock:
        chats = {job.get("chat_id") for (owner, _), job in _exports.items() if owner == user_id and job["state"] == "running"}
    return jsonify({"running": sorted(chat for chat in chats if chat)})


@app.route("/deck/restore", methods=["POST"])
def restore_deck():
    """Put back a previous protocol (the one the last code was generated from)."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    data = request.get_json(silent=True) or {}
    code, original = data.get("code"), data.get("original")
    if not isinstance(code, str) or not code.strip() or not isinstance(original, str):
        return jsonify({"error": "Missing protocol"}), 400
    from deck_library import get_deck
    try:
        api_key, history = _deck_request_context(data, user_id)
        state = get_deck(code, user_id, api_key, history, data.get("template_id"))
        if data.get("chat_id"):
            _save_deck_protocol(data["chat_id"], user_id, original, code)
        return jsonify({"code": code, "state": state})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception:
        app.logger.exception("Protocol restore failed")
        return jsonify({"error": "Could not restore the protocol. Please try again."}), 502


def _save_deck_protocol(chat_id, user_id, original, updated):
    """Persist the displayed file, preserving other code blocks and surrounding text."""
    import re
    conn = get_db_connection()
    try:
        with conn:
            if not fetchone_dict(conn, "SELECT 1 FROM chat_names WHERE chat_id = %s AND user_id = %s AND deleted_at IS NULL FOR UPDATE",
                                 (chat_id, user_id)):
                raise ValueError("Chat not found.")
            rows = fetchall_dict(conn, "SELECT id, content FROM chat_history WHERE chat_id = %s AND user_id = %s AND role = 'assistant' ORDER BY id DESC FOR UPDATE",
                                 (chat_id, user_id))
            normalize = lambda text: text.replace("\r\n", "\n").strip()
            for row in rows:
                content = decrypt_message(row["content"])
                for match in re.finditer(r"```[^\n`]*\n(.*?)\n```", content, re.DOTALL):
                    if normalize(match[1]) == normalize(original):
                        content = content[:match.start(1)] + updated.rstrip("\n") + content[match.end(1):]
                        execute(conn, "UPDATE chat_history SET content = %s WHERE id = %s AND user_id = %s",
                                (encrypt_message(content), row["id"], user_id))
                        return
            # Older clients may already contain an applied file that was never saved.
            # Keep that version without overwriting an unrelated historical protocol.
            execute(conn, "INSERT INTO chat_history (chat_id, user_id, role, content) VALUES (%s, %s, 'assistant', %s)",
                    (chat_id, user_id, encrypt_message("```\n" + updated.rstrip("\n") + "\n```")))
    finally:
        conn.close()


@app.route("/deck/library", methods=["POST"])
def copy_library_deck():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    data = request.get_json(silent=True) or {}
    from deck_library import save_copy
    try:
        return jsonify(save_copy(user_id, data.get("parent_id"), data.get("name"), data.get("layout"))), 201
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.route("/deck/library/<template_id>/publish", methods=["POST"])
def publish_library_deck(template_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403
    from deck_library import publish_deck
    try:
        return jsonify(publish_deck(user_id, template_id))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


@app.route("/deck/catalog", methods=["POST"])
def deck_catalog():
    """Get compatible hardware options for a deck position (LLM-driven)."""
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    platform = data.get("platform", "")
    position_type = data.get("position_type", "labware")

    if not platform:
        return jsonify({"error": "Platform required"}), 400

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

    from deck_library import get_hardware_catalog
    try:
        catalog = get_hardware_catalog(platform, position_type, api_key=user_api_key)
        return jsonify(catalog)
    except Exception as e:
        return jsonify({"error": f"Catalog error: {str(e)}"}), 400


def _feedback_handler(code, chat_id, user_id):
    """Use the same discovered platform registry as protocol generation."""
    conn = get_db_connection()
    try:
        history = fetchall_dict(conn,
            "SELECT role, content FROM chat_history WHERE chat_id = %s AND user_id = %s ORDER BY id",
            (chat_id, user_id)) if chat_id else []
        user = fetchone_dict(conn, "SELECT api_key FROM users WHERE id = %s", (user_id,))
    finally:
        conn.close()
    api_key = (decrypt_text(user["api_key"]) if user and user.get("api_key") else None) or get_api_key()
    history = [{"role": row["role"], "content": decrypt_message(row["content"])} for row in history]
    platform, handlers = detect_handler(code, history, api_key)
    if platform is None:
        raise ValueError("Please specify the robot or instrument in your chat before saving feedback.")
    return platform, handlers[platform]


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

    import hashlib

    try:
        platform, handler = _feedback_handler(code, chat_id, user_id)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    folder = os.path.join(os.path.dirname(__file__), handler["docs_path"], "codes")

    # Create folder if it doesn't exist
    os.makedirs(folder, exist_ok=True)

    # Generate a unique filename from a hash of the code
    code_hash = hashlib.sha256(code.encode()).hexdigest()[:12]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    filename = f"verified_{timestamp}_{code_hash}.txt"
    filepath = os.path.join(folder, filename)

    # Write the file with a header comment
    header = f"""# Verified working protocol
# Platform: {platform}
# Date: {datetime.now().isoformat()}
# Chat: {chat_id}
# ---
"""
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(header + code)

    # Invalidate the RAG cache for this platform so the new code gets indexed
    _invalidate_rag_cache(platform)

    return jsonify({"success": True, "platform": platform, "file": filename})


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

    import hashlib
 
    try:
        platform, handler = _feedback_handler(code, chat_id, user_id)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    code_hash = hashlib.sha256(code.encode()).hexdigest()[:12]
    folder = os.path.join(os.path.dirname(__file__), handler["docs_path"], "failed_codes")
    os.makedirs(folder, exist_ok=True)
 
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
 
    filename = f"failed_{timestamp}_{code_hash}.txt"
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

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(header + code)
 
    _invalidate_rag_cache(platform)
 
    return jsonify({"success": True, "platform": platform, "file": filename})
 
 
def _invalidate_rag_cache(platform):
    """Invalidate the index in the discovered platform's documentation folder."""
    handler = load_handlers_config().get(platform)
    if handler:
        store = os.path.join(os.path.dirname(__file__), handler["docs_path"], handler["store_path"])
        if os.path.exists(store):
            os.remove(store)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
