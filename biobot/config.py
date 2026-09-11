import psycopg2
import os, time

light_functions_model = "gpt-4o-mini"
biobot_model = "gpt-5.6-sol"

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
        cur.execute("""
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token TEXT NOT NULL UNIQUE,
                expires_at TIMESTAMP NOT NULL,
                used BOOLEAN DEFAULT FALSE,
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


# ============================================================
# Platform Detection
# ============================================================

def detect_platform(content: str) -> str:
    """Detect which platform the content is for."""
    content_lower = content.lower()

    # OT-2: Python protocol with load_labware / protocol_api
    if "protocol_api" in content_lower or "load_labware" in content_lower or "load_instrument" in content_lower:
        return "opentrons_ot2"

    # Hamilton STAR: PyHamilton / PyLabRobot / VENUS patterns
    if "pyhamilton" in content_lower or "pylabrobot" in content_lower or \
       "starbackend" in content_lower or "stardeck" in content_lower or \
       "starletdeck" in content_lower or "hamiltoninterface" in content_lower or \
       "tip_car_" in content_lower or "plt_car_" in content_lower or \
       "assign_child_resource" in content_lower or "co-re" in content_lower or \
       ("ml_star" in content_lower and "channel" in content_lower):
        return "hamilton_star"

    # Echo: CSV picklist detection — check multiple patterns
    lines = content.strip().split("\n")
    if len(lines) >= 2:
        header = lines[0].lower()

        # Standard Echo CSV headers
        if ("source" in header and "destination" in header) or \
           ("source plate" in header and "destination plate" in header) or \
           ("source well" in header and "destination well" in header) or \
           ("source well" in header and "volume" in header):
            return "echo_650"

        # No header but data looks like well references with volumes
        first_data = lines[1] if len(lines) > 1 else lines[0]
        fields = first_data.split(",")
        if len(fields) >= 3:
            # Check if any field looks like a well reference (A1, B12, P24, etc.)
            well_pattern = re.compile(r'^[A-P]\d{1,2}$')
            well_fields = [f.strip() for f in fields if well_pattern.match(f.strip())]
            if len(well_fields) >= 2:
                return "echo_650"

    # Check for comma-heavy content with well references
    if content.count(",") > 5 and content.count("\n") > 2:
        well_pattern = re.compile(r'[A-P]\d{1,2}')
        wells_found = well_pattern.findall(content)
        if len(wells_found) > 4:
            # Check if it has volume-like numbers
            num_pattern = re.compile(r'\b\d{2,6}\b')
            nums = num_pattern.findall(content)
            if len(nums) > 2:
                return "echo_650"

    return "unknown"