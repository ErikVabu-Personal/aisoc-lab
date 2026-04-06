import os


def get_openrouter_api_key_from_env_or_kv() -> str:
    """Get OpenRouter API key.

    For simplicity and to avoid native dependency issues (cryptography/glibc), we
    default to environment variable usage. If you want Key Vault secret retrieval,
    implement it using REST + MSI token (similar to log_analytics.py) or add the
    azure-keyvault-secrets/azure-identity deps and build on a compatible runtime.
    """

    key = os.getenv("OPENROUTER_API_KEY", "")
    if not key:
        raise RuntimeError("OpenRouter API key not configured (OPENROUTER_API_KEY)")
    return key
