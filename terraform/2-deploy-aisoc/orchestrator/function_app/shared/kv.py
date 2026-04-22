from __future__ import annotations

import os
import time
from typing import Any

import requests
from azure.identity import DefaultAzureCredential


def _msi_token(resource: str) -> str:
    cred = DefaultAzureCredential()
    tok = cred.get_token(resource + "/.default")
    return tok.token


def get_kv_secret(kv_uri: str, name: str) -> str:
    """Read a Key Vault secret using AAD (managed identity).

    We use Key Vault REST directly to avoid extra dependencies.
    """

    if not kv_uri:
        raise RuntimeError("KEYVAULT_URI missing")

    base = kv_uri.rstrip("/")
    url = f"{base}/secrets/{name}?api-version=7.4"
    token = _msi_token("https://vault.azure.net")

    r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"KeyVault secret get failed ({r.status_code}): {r.text[:4000]}")

    j: Any = r.json()
    val = j.get("value") if isinstance(j, dict) else None
    if not isinstance(val, str) or not val:
        raise RuntimeError("KeyVault secret value missing")
    return val
