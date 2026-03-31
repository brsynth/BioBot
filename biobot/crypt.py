"""
Encryption utilities for BioBot chat privacy.

Uses Fernet (AES-128-CBC + HMAC-SHA256) with keys derived from the user's
password via PBKDF2-HMAC-SHA256.

- At registration: a random salt is generated and stored in the users table.
- At login: the key is re-derived from password + salt and stored in the
  Flask session for the duration of the session.
- All chat content and chat names are encrypted before DB writes and
  decrypted after DB reads.
"""

import base64
import os
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


def generate_salt() -> str:
    """Generate a random 16-byte salt, returned as a hex string for DB storage."""
    return os.urandom(16).hex()


def derive_key(password: str, salt_hex: str) -> bytes:
    """
    Derive a Fernet-compatible 32-byte key from a password and hex-encoded salt.
    Returns the key as a url-safe base64-encoded bytes object (as Fernet expects).
    """
    salt = bytes.fromhex(salt_hex)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=480_000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(password.encode("utf-8")))
    return key


def encrypt(plaintext: str, key: bytes) -> str:
    """
    Encrypt a plaintext string. Returns a base64-encoded ciphertext string
    safe for storage in a TEXT column.
    """
    if not plaintext:
        return plaintext
    f = Fernet(key)
    return f.encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt(ciphertext: str, key: bytes) -> str:
    """
    Decrypt a ciphertext string back to plaintext.
    Returns the original string.
    """
    if not ciphertext:
        return ciphertext
    f = Fernet(key)
    return f.decrypt(ciphertext.encode("utf-8")).decode("utf-8")