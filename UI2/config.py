import psycopg2
import os, time


def get_api_key():
    secret_path = "/run/secrets/biobot_api_key"
    if os.path.exists(secret_path):
        with open(secret_path, "r") as f:
            return f.read().strip()
    env_key = os.environ.get("API_KEY")
    if env_key:
        return env_key
    raise ValueError("API KEY not found")


def get_db_password():
    secret_path = "/run/secrets/db_password"
    if os.path.exists(secret_path):
        with open(secret_path, "r") as f:
            return f.read().strip()
    env_pw = os.environ.get("DB_PASS") or os.environ.get("DB_PASSWORD")
    if env_pw:
        return env_pw
    raise ValueError("DB password not found")


def get_db_connection():
    """
    Returns a new psycopg2 connection. Caller must close it.
    """
    db_password = get_db_password()
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST", "postgres"),
        port=int(os.getenv("DB_PORT", 5432)),
        dbname=os.getenv("DB_NAME", "biobotdb"),
        user=os.getenv("DB_USER", "biobotuser"),
        password=db_password
    )
    return conn

def init_db():
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                first_name TEXT,
                last_name TEXT,
                email TEXT UNIQUE,
                password TEXT,
                api_key TEXT,
                role TEXT,
                country TEXT,
                encryption_salt TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS chat_names (
                chat_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS chat_history (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                chat_id TEXT NOT NULL REFERENCES chat_names(chat_id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.commit()
    finally:
        conn.close()

def wait_for_postgres(retries=60, delay=2):
    attempts = 0
    while attempts < retries:
        try:
            conn = get_db_connection()
            conn.close()
            print("Postgres is ready!")
            return True
        except Exception as e:
            attempts += 1
            print(f"Waiting for Postgres... (attempt {attempts}) error: {e}")
            time.sleep(delay)
    raise RuntimeError("Postgres did not become ready in time")