"""Account administration from the command line.

    docker compose exec biobot python admin.py reset EMAIL --generate   # random password, printed once
    docker compose exec biobot python admin.py reset EMAIL              # prompts for the new password

The user's API key is replaced by the server default (API_KEY): their own key was encrypted
with the old password and cannot be recovered without it, as with "Forgot password".
"""
import argparse
import getpass
import secrets
import sys

from werkzeug.security import generate_password_hash

from config import get_db_connection, get_api_key
from crypt import generate_salt, derive_key, encrypt


def reset_password(email, password):
    salt = generate_salt()
    api_key = get_api_key(required=False)
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("UPDATE users SET password = %s, api_key = %s, encryption_salt = %s WHERE lower(email) = lower(%s)",
                    (generate_password_hash(password), encrypt(api_key, derive_key(password, salt)) if api_key else None,
                     salt, email))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(prog="admin.py", description="BioBot account administration")
    sub = parser.add_subparsers(dest="command", required=True)
    reset = sub.add_parser("reset", help="Reset a user's password")
    reset.add_argument("email")
    reset.add_argument("--generate", action="store_true", help="Set a random password and print it")
    args = parser.parse_args()

    if args.generate:
        password = secrets.token_urlsafe(12)
    else:
        password = getpass.getpass("New password: ")
        if len(password) < 6:
            sys.exit("Password must be at least 6 characters.")
        if password != getpass.getpass("Confirm: "):
            sys.exit("Passwords do not match.")

    if not reset_password(args.email, password):
        sys.exit(f"No user with email {args.email}.")
    print(f"Password reset for {args.email}" + (f": {password}" if args.generate else "."))


if __name__ == "__main__":
    main()
