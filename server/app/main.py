from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor
from importlib.util import find_spec
from pathlib import Path
from typing import Annotated, Optional, Union

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .processor import (
    ProcessingError,
    export_video,
    probe_duration,
    process_video,
    render_text_edits,
    render_timeline_edits,
)
from .schemas import CleanerSettings, CutSegment, JobRecord
from .store import JobStore


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("AUTO_VIDEO_CLEANER_DATA_DIR", BASE_DIR / "data" / "jobs")).expanduser()
DATA_DIR.mkdir(parents=True, exist_ok=True)
IS_DESKTOP = os.getenv("AUTO_VIDEO_CLEANER_DESKTOP") == "1"
CLIENT_DIR = Path(os.getenv("AUTO_VIDEO_CLEANER_CLIENT_DIR", "")).expanduser()

app = FastAPI(title="Auto Video Cleaner API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        *(['null'] if IS_DESKTOP else []),
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = JobStore()
executor = ThreadPoolExecutor(max_workers=2)

if IS_DESKTOP and CLIENT_DIR.exists():
    assets_dir = CLIENT_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.get("/", include_in_schema=False)
def desktop_index() -> FileResponse:
    index_path = CLIENT_DIR / "index.html"
    if not IS_DESKTOP or not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend no disponible.")
    return FileResponse(index_path, media_type="text/html")


@app.get("/api/health")
def health() -> dict[str, Union[str, bool]]:
    return {
        "ok": True,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "dialogue_cleanup": find_spec("faster_whisper") is not None,
    }


@app.post("/api/jobs")
async def create_job(
    file: Annotated[UploadFile, File()],
) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Sube un archivo de video valido.")

    original_name = _safe_filename(file.filename)
    if not _looks_like_video(original_name):
        raise HTTPException(status_code=400, detail="Formato no soportado. Sube MP4, MOV, M4V, MKV o WEBM.")

    job_id = uuid.uuid4().hex
    work_dir = DATA_DIR / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    input_path = work_dir / f"source{Path(original_name).suffix.lower()}"

    with input_path.open("wb") as target:
        while chunk := await file.read(1024 * 1024):
            target.write(chunk)

    duration = None
    try:
        duration = probe_duration(input_path)
    except Exception:
        duration = None

    job = JobRecord(id=job_id, filename=original_name, duration=duration)
    store.add(job)
    return job.to_dict()


@app.post("/api/jobs/{job_id}/process")
def process_job(
    job_id: str,
    silence_threshold_db: Annotated[float, Form()] = -35.0,
    min_silence_sec: Annotated[float, Form()] = 0.45,
    keep_silence_sec: Annotated[float, Form()] = 0.12,
    crf: Annotated[int, Form()] = 12,
    enable_transcription: Annotated[bool, Form()] = True,
    enable_ai_cleanup: Annotated[bool, Form()] = False,
    language: Annotated[str, Form()] = "es",
) -> dict:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job no encontrado.")
    if job.status in {"queued", "analyzing", "rendering"}:
        raise HTTPException(status_code=409, detail="Este video ya se esta procesando.")

    work_dir = DATA_DIR / job_id
    input_path = _source_path(work_dir)
    if input_path is None:
        raise HTTPException(status_code=404, detail="No encontre el archivo fuente de este job.")

    settings = CleanerSettings(
        silence_threshold_db=silence_threshold_db,
        min_silence_sec=min_silence_sec,
        keep_silence_sec=keep_silence_sec,
        crf=crf,
        enable_transcription=enable_transcription,
        enable_ai_cleanup=enable_ai_cleanup,
        language=language,
    ).normalized()

    _cleanup_previous_outputs(work_dir)
    next_job = store.update(
        job_id,
        status="queued",
        progress=0.0,
        message="En cola para procesar",
        settings=settings,
        duration=None,
        cleaned_duration=None,
        cuts=[],
        ai_notes=[],
        error=None,
    )
    executor.submit(_run_job, job_id, input_path, work_dir, settings)
    return next_job.to_dict()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job no encontrado.")
    return job.to_dict()


@app.get("/api/jobs/{job_id}/transcript")
def transcript(job_id: str) -> dict:
    _job, work_dir = _existing_job(job_id)
    path = work_dir / "transcript.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Todavia no hay transcripcion para este video.")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="La transcripcion guardada no se pudo leer.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="La transcripcion guardada no tiene formato valido.")
    payload["text_cuts"] = _read_cut_payload(work_dir / "text_cuts.json")
    return payload


@app.post("/api/jobs/{job_id}/text-edits")
def apply_text_edits(job_id: str, payload: dict) -> dict:
    job, work_dir = _completed_job(job_id)
    manual_cuts = _parse_cut_payload(payload, "Manda una lista de cortes por texto.")
    input_path = _source_path(work_dir)
    if input_path is None:
        raise HTTPException(status_code=404, detail="No encontre el archivo fuente de este job.")

    next_job = store.update(
        job_id,
        status="rendering",
        progress=0.5,
        message="Aplicando cortes por texto",
        error=None,
    )
    executor.submit(_run_text_edit_job, job_id, input_path, work_dir, job.settings, manual_cuts)
    return next_job.to_dict()


@app.post("/api/jobs/{job_id}/timeline-edits")
def apply_timeline_edits(job_id: str, payload: dict) -> dict:
    job, work_dir = _completed_job(job_id)
    timeline_cuts = _parse_cut_payload(payload, "Manda una lista de cortes del timeline.")
    input_path = _source_path(work_dir)
    if input_path is None:
        raise HTTPException(status_code=404, detail="No encontre el archivo fuente de este job.")

    next_job = store.update(
        job_id,
        status="rendering",
        progress=0.5,
        message="Aplicando timeline",
        error=None,
    )
    executor.submit(_run_timeline_edit_job, job_id, input_path, work_dir, job.settings, timeline_cuts)
    return next_job.to_dict()


@app.get("/api/jobs/{job_id}/source")
def source(job_id: str) -> FileResponse:
    job, work_dir = _existing_job(job_id)
    path = _source_path(work_dir)
    if path is None:
        raise HTTPException(status_code=404, detail="Archivo fuente no encontrado.")
    return FileResponse(path, media_type=_media_type_for(path), filename=job.filename)


@app.get("/api/jobs/{job_id}/preview")
def preview(job_id: str) -> FileResponse:
    job, work_dir = _completed_job(job_id)
    path = work_dir / "cleaned.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Preview no encontrado.")
    return FileResponse(path, media_type="video/mp4", filename=f"{Path(job.filename).stem}-cleaned.mp4")


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str, format: str = "mp4") -> FileResponse:
    job, work_dir = _completed_job(job_id)
    fmt = format.lower()
    try:
        path = export_video(work_dir, fmt)
    except ProcessingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    media_type = "video/quicktime" if fmt == "mov" else "video/mp4"
    return FileResponse(path, media_type=media_type, filename=f"{Path(job.filename).stem}-cleaned.{fmt}")


def _run_job(job_id: str, input_path: Path, work_dir: Path, settings: CleanerSettings) -> None:
    def progress(value: float, message: str) -> None:
        store.update(job_id, progress=round(value, 3), message=message)

    try:
        store.update(job_id, status="analyzing", progress=0.02, message="Preparando analisis")
        duration, cleaned_duration, cuts, ai_notes, _output_path = process_video(input_path, work_dir, settings, progress)
        store.update(
            job_id,
            status="completed",
            progress=1.0,
            message="Video corregido listo",
            duration=duration,
            cleaned_duration=cleaned_duration,
            cuts=cuts,
            ai_notes=ai_notes,
            render_version=_next_render_version(job_id),
        )
    except Exception as exc:
        message = str(exc) if str(exc) else "Error desconocido procesando el video."
        store.update(job_id, status="failed", progress=1.0, message=message, error=message)


def _run_text_edit_job(
    job_id: str,
    input_path: Path,
    work_dir: Path,
    settings: CleanerSettings,
    manual_cuts: list[CutSegment],
) -> None:
    def progress(value: float, message: str) -> None:
        store.update(job_id, progress=round(value, 3), message=message)

    try:
        duration, cleaned_duration, cuts, _output_path = render_text_edits(
            input_path,
            work_dir,
            manual_cuts,
            settings,
            progress,
        )
        store.update(
            job_id,
            status="completed",
            progress=1.0,
            message="Cortes por texto aplicados",
            duration=duration,
            cleaned_duration=cleaned_duration,
            cuts=cuts,
            render_version=_next_render_version(job_id),
        )
    except Exception as exc:
        message = str(exc) if str(exc) else "Error desconocido aplicando cortes por texto."
        store.update(job_id, status="failed", progress=1.0, message=message, error=message)


def _run_timeline_edit_job(
    job_id: str,
    input_path: Path,
    work_dir: Path,
    settings: CleanerSettings,
    timeline_cuts: list[CutSegment],
) -> None:
    def progress(value: float, message: str) -> None:
        store.update(job_id, progress=round(value, 3), message=message)

    try:
        duration, cleaned_duration, cuts, _output_path = render_timeline_edits(
            input_path,
            work_dir,
            timeline_cuts,
            settings,
            progress,
        )
        store.update(
            job_id,
            status="completed",
            progress=1.0,
            message="Timeline aplicado",
            duration=duration,
            cleaned_duration=cleaned_duration,
            cuts=cuts,
            render_version=_next_render_version(job_id),
        )
    except Exception as exc:
        message = str(exc) if str(exc) else "Error desconocido aplicando el timeline."
        store.update(job_id, status="failed", progress=1.0, message=message, error=message)


def _completed_job(job_id: str) -> tuple[JobRecord, Path]:
    job, work_dir = _existing_job(job_id)
    if job.status != "completed":
        raise HTTPException(status_code=409, detail="El video todavia no termina de procesarse.")
    return job, work_dir


def _existing_job(job_id: str) -> tuple[JobRecord, Path]:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job no encontrado.")
    return job, DATA_DIR / job_id


def _safe_filename(filename: str) -> str:
    name = Path(filename).name.strip() or "video.mp4"
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "", Path(name).stem).strip() or "video"
    suffix = Path(name).suffix.lower()
    return f"{stem[:80]}{suffix}"


def _looks_like_video(filename: str) -> bool:
    return Path(filename).suffix.lower() in {".mp4", ".mov", ".m4v", ".mkv", ".webm"}


def _media_type_for(path: Path) -> str:
    if path.suffix.lower() == ".mov":
        return "video/quicktime"
    if path.suffix.lower() == ".webm":
        return "video/webm"
    return "video/mp4"


def _source_path(work_dir: Path) -> Optional[Path]:
    for path in work_dir.glob("source.*"):
        if path.is_file():
            return path
    return None


def _cleanup_previous_outputs(work_dir: Path) -> None:
    for filename in (
        "cleaned.mp4",
        "cleaned.mov",
        "cleaned.filter",
        "cuts.json",
        "base_cuts.json",
        "text_cuts.json",
        "transcript.json",
        "ai_suggestions.json",
    ):
        path = work_dir / filename
        if path.exists():
            path.unlink()


def _parse_cut_payload(payload: dict, missing_message: str) -> list[CutSegment]:
    raw_cuts = payload.get("cuts")
    if not isinstance(raw_cuts, list):
        raise HTTPException(status_code=400, detail=missing_message)

    cuts: list[CutSegment] = []
    for raw_cut in raw_cuts:
        if not isinstance(raw_cut, dict):
            raise HTTPException(status_code=400, detail="Cada corte debe ser un objeto.")
        try:
            start = float(raw_cut["start"])
            end = float(raw_cut["end"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Cada corte necesita start y end numericos.") from exc
        if start < 0 or end <= start:
            raise HTTPException(status_code=400, detail="Los cortes por texto necesitan tiempos validos.")
        reason = str(raw_cut.get("reason") or "Texto eliminado")[:160]
        cuts.append(CutSegment(start=start, end=end, reason=reason))
    return cuts


def _read_cut_payload(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return payload if isinstance(payload, list) else []


def _next_render_version(job_id: str) -> int:
    job = store.get(job_id)
    return (job.render_version if job else 0) + 1
