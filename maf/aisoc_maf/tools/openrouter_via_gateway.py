from __future__ import annotations

import requests

from aisoc_maf.config import Config


class OpenRouterViaGateway:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def _url(self, path: str) -> str:
        path = path.lstrip("/")
        return f"{self.cfg.gateway_base_url}/{path}"

    def _params(self) -> dict:
        p = {}
        if self.cfg.function_code:
            p["code"] = self.cfg.function_code
        return p

    def chat(self, prompt: str, model: str = "openai/gpt-4o-mini") -> dict:
        headers = {"Content-Type": "application/json"}
        # LLM endpoint is read-scoped
        if self.cfg.read_key:
            headers["x-aisoc-key"] = self.cfg.read_key

        r = requests.post(
            self._url("llm/openrouter"),
            params=self._params(),
            headers=headers,
            json={"prompt": prompt, "model": model},
            timeout=90,
        )
        r.raise_for_status()
        return r.json()
