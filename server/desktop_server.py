from __future__ import annotations

import multiprocessing
import os

import uvicorn

from app.main import app


def main() -> None:
    port = int(os.getenv("AUTO_VIDEO_CLEANER_PORT", "8000"))
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level=os.getenv("UVICORN_LOG_LEVEL", "info"),
        access_log=os.getenv("UVICORN_ACCESS_LOG", "0") == "1",
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
