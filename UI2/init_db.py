import time
from app import wait_for_postgres, init_db

if __name__ == "__main__":
    wait_for_postgres()
    try:
        init_db()
        print("PostgreSQL DB initialized / tables checked.")
    except Exception as e:
        print("⚠️ init_db error:", e)
