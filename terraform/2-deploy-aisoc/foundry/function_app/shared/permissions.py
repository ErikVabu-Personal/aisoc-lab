import os


def require_key(req, env_var: str) -> None:
    """Require a per-scope API key passed via header or query string.

    Header:  x-aisoc-key: <key>
    Query:   ?aisoc_key=<key>

    env_var is the name of the environment variable containing the expected key.
    """
    expected = os.getenv(env_var, "")
    if not expected:
        raise PermissionError(f"Server misconfigured: missing {env_var}")

    provided = req.headers.get("x-aisoc-key") or req.params.get("aisoc_key") or ""
    if provided != expected:
        raise PermissionError("Forbidden")
