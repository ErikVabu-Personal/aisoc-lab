from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    gateway_base_url: str
    function_code: str | None
    read_key: str | None
    write_key: str | None


def load_config() -> Config:
    base = os.environ.get("AISOC_GATEWAY_BASE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("AISOC_GATEWAY_BASE_URL is required")

    return Config(
        gateway_base_url=base,
        function_code=os.environ.get("AISOC_FUNCTION_CODE"),
        read_key=os.environ.get("AISOC_READ_KEY"),
        write_key=os.environ.get("AISOC_WRITE_KEY"),
    )
