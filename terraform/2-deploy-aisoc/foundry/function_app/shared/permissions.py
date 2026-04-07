import os

import requests


def _get_msi_token(resource: str) -> str:
    """Get an MSI token from the App Service managed identity endpoint."""
    endpoint = os.getenv("IDENTITY_ENDPOINT")
    header = os.getenv("IDENTITY_HEADER")
    if not endpoint or not header:
        raise RuntimeError("Managed identity endpoint not available")

    r = requests.get(
        endpoint,
        params={"resource": resource, "api-version": "2019-08-01"},
        headers={"X-IDENTITY-HEADER": header},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def _kv_get_secret(secret_uri: str) -> str:
    """Fetch a Key Vault secret value using managed identity."""
    token = _get_msi_token("https://vault.azure.net")
    r = requests.get(
        secret_uri,
        params={"api-version": "7.4"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()["value"]


def _resolve_expected_key(env_var: str) -> str:
    """Resolve expected key from env var.

    Supports either:
    - direct value in env var
    - Key Vault reference string: @Microsoft.KeyVault(SecretUri=https://.../secrets/<name>/<ver>)

    If a Key Vault reference is present but not resolved into the env var at runtime,
    we fall back to fetching the secret directly via managed identity.
    """
    expected = os.getenv(env_var, "")
    if expected.startswith("@Microsoft.KeyVault(SecretUri=") and expected.endswith(")"):
        secret_uri = expected[len("@Microsoft.KeyVault(SecretUri=") : -1]
        return _kv_get_secret(secret_uri)

    return expected


def require_key(req, env_var: str) -> None:
    """Require a per-scope API key passed via header or query string.

    Header:  x-aisoc-key: <key>
    Query:   ?aisoc_key=<key>

    env_var is the name of the environment variable containing the expected key.
    """

    expected = _resolve_expected_key(env_var)
    if not expected:
        raise PermissionError(f"Server misconfigured: missing {env_var}")

    provided = req.headers.get("x-aisoc-key") or req.params.get("aisoc_key") or ""
    if provided != expected:
        raise PermissionError("Forbidden")
