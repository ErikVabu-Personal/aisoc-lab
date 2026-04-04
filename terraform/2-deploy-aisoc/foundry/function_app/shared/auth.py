import os


def get_openrouter_api_key_from_env_or_kv() -> str:
    # Prefer Key Vault via managed identity if KEYVAULT_URI is set
    kv_uri = os.getenv("KEYVAULT_URI")
    if kv_uri:
        from azure.identity import DefaultAzureCredential
        from azure.keyvault.secrets import SecretClient

        client = SecretClient(vault_url=kv_uri, credential=DefaultAzureCredential())
        return client.get_secret("OPENROUTER-API-KEY").value

    # Fallback to env
    key = os.getenv("OPENROUTER_API_KEY", "")
    if not key:
        raise RuntimeError("OpenRouter API key not configured (KEYVAULT_URI or OPENROUTER_API_KEY)")
    return key
