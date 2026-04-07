from __future__ import annotations

import requests

from aisoc_maf.config import Config


class SOCGateway:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def _url(self, path: str) -> str:
        path = path.lstrip("/")
        return f"{self.cfg.gateway_base_url}/{path}"

    def _params(self) -> dict:
        # Azure Functions function key
        p = {}
        if self.cfg.function_code:
            p["code"] = self.cfg.function_code
        return p

    def kql_query(self, query: str, timespan: str = "PT1H") -> dict:
        headers = {"Content-Type": "application/json"}
        if self.cfg.read_key:
            headers["x-aisoc-key"] = self.cfg.read_key

        r = requests.post(
            self._url("kql/query"),
            params=self._params(),
            headers=headers,
            json={"query": query, "timespan": timespan},
            timeout=60,
        )
        r.raise_for_status()
        return r.json()

    def list_incidents(self) -> dict:
        headers = {}
        if self.cfg.read_key:
            headers["x-aisoc-key"] = self.cfg.read_key

        r = requests.get(
            self._url("sentinel/incidents"),
            params=self._params(),
            headers=headers,
            timeout=60,
        )
        r.raise_for_status()
        return r.json()

    def get_incident(self, incident_id: str) -> dict:
        headers = {}
        if self.cfg.read_key:
            headers["x-aisoc-key"] = self.cfg.read_key

        r = requests.get(
            self._url(f"sentinel/incidents/{incident_id}"),
            params=self._params(),
            headers=headers,
            timeout=60,
        )
        r.raise_for_status()
        return r.json()

    def update_incident(self, incident_id: str, patch: dict) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.cfg.write_key:
            headers["x-aisoc-key"] = self.cfg.write_key

        r = requests.patch(
            self._url(f"sentinel/incidents/{incident_id}"),
            params=self._params(),
            headers=headers,
            json=patch,
            timeout=60,
        )
        r.raise_for_status()
        return r.json()
