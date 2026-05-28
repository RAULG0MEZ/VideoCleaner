from __future__ import annotations

from copy import deepcopy
from threading import Lock
from typing import Any, Optional

from .schemas import JobRecord


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, JobRecord] = {}
        self._lock = Lock()

    def add(self, job: JobRecord) -> None:
        with self._lock:
            self._jobs[job.id] = job

    def get(self, job_id: str) -> Optional[JobRecord]:
        with self._lock:
            job = self._jobs.get(job_id)
            return deepcopy(job) if job else None

    def update(self, job_id: str, **changes: Any) -> JobRecord:
        with self._lock:
            job = self._jobs[job_id]
            for key, value in changes.items():
                setattr(job, key, value)
            return deepcopy(job)
