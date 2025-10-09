from flask import Flask, request, jsonify, render_template, redirect, url_for, session, flash
import uuid
import requests
import json
import os
from datetime import datetime
import sqlite3
from werkzeug.security import generate_password_hash, check_password_hash
from engine import process_user_query 

def get_api_key():
    secret_path = "/run/secrets/brsbot_api_key"
    if os.path.exists(secret_path):
        with open(secret_path, "r") as f:
            return f.read().strip()
    else:
        raise ValueError("API KEY not found")


app = Flask(__name__)
app.config["SESSION_PERMANENT"] = False


app.secret_key = "super_secret_key"

DB_PATH = "database.db"

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

MODEL_NAME = "gpt-5"  # modèle unique par défaut


# === SYSTEM PROMPT COMMUN ===
SYSTEM_PROMPT = {
    "role": "system",
    "content": """You are BioRSbot 🤖, an expert assistant specialized in lab automation, particularly with liquid handling robots.
Your tasks:
- A chat history is provided to help you recall previous interactions, but **do not process the entire history as new instructions**; use it only if you need to reference something the user said before. To answer, focus primarily on the **latest user message**.
- Generate clean, error-free Python code for operating lab robots."""
}

# === Login and register ROUTES ===
@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        first_name = request.form["first_name"]
        last_name = request.form["last_name"]
        email = request.form["email"]
        password = generate_password_hash(request.form["password"])
        api_key = request.form.get("api_key", "").strip() or get_api_key()
        role = request.form.get("role", "")
        country = request.form.get("country", "")
        

        try:
            conn = get_db_connection()
            conn.execute("""
                INSERT INTO users (first_name, last_name, email, password, api_key, role, country, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (first_name, last_name, email, password, api_key, role, country, datetime.now().isoformat()))
            conn.commit()
            conn.close()
            flash("Inscription réussie ! Connectez-vous.", "success")
            return redirect("/login")
        except sqlite3.IntegrityError:
            flash("Email déjà utilisé.", "error")
            return redirect("/register")
    
    return render_template("register.html")



@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form["email"]
        password = request.form["password"]

        conn = get_db_connection()
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        conn.close()

        if user and check_password_hash(user["password"], password):
            session["user"] = user["id"]
            return redirect("/")
        else:
            flash("Email ou mot de passe incorrect !", "error")
            return redirect("/login")
    
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.pop("user", None)
    flash("Vous avez été déconnecté.", "info")
    return redirect(url_for("login"))

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

    conn = get_db_connection()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()

    if not user:
        session.pop("user", None)
        return redirect("/login")

    return render_template("index.html", user=user)



@app.route("/chat", methods=["POST"])
def create_chat():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    chat_id = str(uuid.uuid4())
    title = "New chat"

    conn = get_db_connection()
    conn.execute(
        "INSERT INTO chat_names (chat_id, user_id, name) VALUES (?, ?, ?)",
        (chat_id, user_id, title)
    )

    system_message = SYSTEM_PROMPT["content"]
    conn.execute(
        "INSERT INTO chat_history (user_id, chat_id, role, content) VALUES (?, ?, ?, ?)",
        (user_id, chat_id, "system", system_message)
    )

    intro_message = "Hello, I'm BioRSbot 🤖 — your assistant specialized in lab automation..."
    conn.execute(
        "INSERT INTO chat_history (user_id, chat_id, role, content) VALUES (?, ?, ?, ?)",
        (user_id, chat_id, "assistant", intro_message)
    )

    conn.commit()
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

    conn = get_db_connection()

    # Vérifie si ce chat existe déjà
    chat_exists = conn.execute(
        "SELECT 1 FROM chat_names WHERE chat_id = ? AND user_id = ?",
        (chat_id, user_id)
    ).fetchone()

    # Ajout du message utilisateur
    conn.execute(
        "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        (user_id, chat_id, "user", user_message, datetime.now().isoformat())
    )
    conn.commit()

    # Récupérer l’historique complet
    rows = conn.execute(
        "SELECT role, content FROM chat_history WHERE user_id = ? AND chat_id = ? ORDER BY created_at",
        (user_id, chat_id)
    ).fetchall()
    
    user = conn.execute(
    "SELECT api_key FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    conn.close()
    
    user_api_key = user["api_key"] if user and user["api_key"] else None

    messages = [{"role": r["role"], "content": r["content"]} for r in rows]
    
    bot_reply = process_user_query(user_message,messages, MODEL_NAME, api_key = user_api_key)

    # Sauvegarde de la réponse du bot
    conn = get_db_connection()
    conn.execute(
        "INSERT INTO chat_history (user_id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        (user_id, chat_id, "assistant", bot_reply, datetime.now().isoformat())
    )

    # Renommer automatiquement le chat si c’était encore New chat
    title_row = conn.execute(
        "SELECT name FROM chat_names WHERE chat_id = ? AND user_id = ?", (chat_id, user_id)
    ).fetchone()
    if title_row and title_row["name"] == "New chat":
        preview_words = user_message.strip().split()
        preview = " ".join(preview_words[:5])
        if len(preview_words) > 5:
            preview += "..."
        conn.execute(
            "UPDATE chat_names SET name = ? WHERE chat_id = ? AND user_id = ?",
            (preview, chat_id, user_id)
        )
    conn.commit()
    conn.close()

    return jsonify({"reply": bot_reply})




@app.route("/chat/<chat_id>", methods=["GET"])
def get_history(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = get_db_connection()
    rows = conn.execute(
        "SELECT role, content FROM chat_history WHERE user_id = ? AND chat_id = ? ORDER BY created_at",
        (user_id, chat_id)
    ).fetchall()
    conn.close()

    visible_messages = [ {"role": r["role"], "content": r["content"]} for r in rows if r["role"] != "system" ]
    return jsonify(visible_messages)


@app.route("/chat/<chat_id>", methods=["DELETE"])
def delete_chat(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = get_db_connection()

    # Supprimer les messages de ce chat pour cet utilisateur
    conn.execute(
        "DELETE FROM chat_history WHERE chat_id = ? AND user_id = ?",
        (chat_id, user_id)
    )

    # Supprimer le nom du chat
    conn.execute(
        "DELETE FROM chat_names WHERE chat_id = ? AND user_id = ?",
        (chat_id, user_id)
    )

    conn.commit()
    conn.close()

    return jsonify({"success": True})


@app.route("/chats", methods=["GET"])
def list_chats():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = get_db_connection()
    rows = conn.execute(
        "SELECT chat_id, name FROM chat_names WHERE user_id = ?", (user_id,)
    ).fetchall()
    conn.close()

    return jsonify([{"chat_id": r["chat_id"], "name": r["name"]} for r in rows])

@app.route("/chat/<chat_id>/rename", methods=["POST"])
def rename_chat(chat_id):
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    data = request.get_json()
    new_name = data.get("name", "").strip()
    if not new_name:
        return jsonify({"error": "Name required"}), 400

    conn = get_db_connection()
    conn.execute(
        "UPDATE chat_names SET name = ? WHERE chat_id = ? AND user_id = ?",
        (new_name, chat_id, user_id)
    )
    conn.commit()
    conn.close()

    return jsonify({"success": True})


# Récupérer les infos de l'utilisateur connecté
@app.route("/user/profile", methods=["GET"])
def get_user_profile():
    user_id = session.get("user")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 403

    conn = get_db_connection()
    user = conn.execute(
        "SELECT id, first_name, last_name, email, api_key, role, country, created_at FROM users WHERE id = ?", 
        (user_id,)
    ).fetchone()
    conn.close()

    if not user:
        return jsonify({"error": "User not found"}), 404

    return jsonify(dict(user))


# Modifier les infos utilisateur
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

    conn = get_db_connection()
    try:
        conn.execute("""
            UPDATE users SET first_name = ?, last_name = ?, email = ?, api_key = ?, country = ?
            WHERE id = ?
        """, (first_name, last_name, email, api_key, country, user_id))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({"error": "Email already exists"}), 400

    conn.close()
    return jsonify({"success": True})



if __name__ == "__main__": 
    app.run()