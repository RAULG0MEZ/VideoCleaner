from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional, Union


JobStatus = Literal["uploaded", "queued", "analyzing", "rendering", "completed", "failed"]


@dataclass
class CleanerSettings:
    silence_threshold_db: float = -35.0
    min_silence_sec: float = 0.45
    keep_silence_sec: float = 0.12
    crf: int = 12
    enable_transcription: bool = True
    enable_ai_cleanup: bool = False
    language: str = "es"

    def normalized(self) -> "CleanerSettings":
        return CleanerSettings(
            silence_threshold_db=max(-80.0, min(-10.0, self.silence_threshold_db)),
            min_silence_sec=max(0.15, min(5.0, self.min_silence_sec)),
            keep_silence_sec=max(0.0, min(1.0, self.keep_silence_sec)),
            crf=12,
            enable_transcription=self.enable_transcription,
            enable_ai_cleanup=self.enable_ai_cleanup,
            language=(self.language or "es").strip().lower()[:8],
        )


@dataclass
class CutSegment:
    start: float
    end: float
    reason: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def to_dict(self) -> dict[str, Union[float, str]]:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "duration": round(self.duration, 3),
            "reason": self.reason,
        }


@dataclass
class JobRecord:
    id: str
    filename: str
    status: JobStatus = "uploaded"
    progress: float = 0.0
    message: str = "Cargado"
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    settings: CleanerSettings = field(default_factory=CleanerSettings)
    duration: Optional[float] = None
    cleaned_duration: Optional[float] = None
    cuts: list[CutSegment] = field(default_factory=list)
    ai_notes: list[str] = field(default_factory=list)
    error: Optional[str] = None
    render_version: int = 0

    def to_dict(self) -> dict:
        data = asdict(self)
        data["settings"] = asdict(self.settings)
        data["cuts"] = [cut.to_dict() for cut in self.cuts]
        data["source_url"] = f"/api/jobs/{self.id}/source"
        if self.status == "completed":
            data["preview_url"] = f"/api/jobs/{self.id}/preview?v={self.render_version}"
            data["download_urls"] = {
                "mp4": f"/api/jobs/{self.id}/download?format=mp4&v={self.render_version}",
                "mov": f"/api/jobs/{self.id}/download?format=mov&v={self.render_version}",
            }
        return data
