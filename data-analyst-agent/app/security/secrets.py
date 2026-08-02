from cryptography.fernet import Fernet

from app.config import settings

_fernet = Fernet(settings.token_encryption_key.encode())


def encrypt_token(raw_token: str) -> bytes:
    return _fernet.encrypt(raw_token.encode())


def decrypt_token(ciphertext: bytes) -> str:
    return _fernet.decrypt(ciphertext).decode()
