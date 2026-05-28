from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Optional

from .ai_cleanup import suggest_dialogue_cuts, transcribe_dialogue
from .schemas import CleanerSettings, CutSegment


class ProcessingError(RuntimeError):
    pass


ProgressCallback = Callable[[float, str], None]
CUTS_FILENAME = "cuts.json"
BASE_CUTS_FILENAME = "base_cuts.json"
TEXT_CUTS_FILENAME = "text_cuts.json"
NON_MEDIA_INPUT_OPTIONS = ["-sn", "-dn"]
AUDIO_ONLY_INPUT_OPTIONS = ["-vn", *NON_MEDIA_INPUT_OPTIONS]


def process_video(
    input_path: Path,
    work_dir: Path,
    settings: CleanerSettings,
    progress: ProgressCallback,
    text_cuts: Optional[list[CutSegment]] = None,
) -> tuple[float, float, list[CutSegment], list[str], Path]:
    require_ffmpeg()
    progress(0.08, "Inspeccionando video")

    duration = probe_duration(input_path)
    if duration <= 0:
        raise ProcessingError("No pude leer la duracion del video.")
    if not probe_has_audio(input_path):
        raise ProcessingError("El video no tiene pista de audio para analizar.")

    progress(0.2, "Detectando silencios y pausas largas")
    silence_cuts = detect_silence_cuts(input_path, duration, settings)

    ai_cuts: list[CutSegment] = []
    ai_notes: list[str] = []
    if settings.enable_ai_cleanup:
        progress(0.42, "Analizando dialogo con IA")
        dialogue_result = suggest_dialogue_cuts(input_path, work_dir, settings)
        ai_cuts = dialogue_result.cuts
        ai_notes = dialogue_result.notes
    elif settings.enable_transcription:
        progress(0.42, "Transcribiendo dialogo")
        transcript_result = transcribe_dialogue(input_path, work_dir, settings)
        ai_notes = transcript_result.notes

    base_cuts = merge_cuts([*silence_cuts, *ai_cuts], duration)
    cuts = base_cuts
    if text_cuts is not None:
        text_cuts = merge_cuts(text_cuts, duration, gap=0.02)
        cuts = merge_cuts([*base_cuts, *text_cuts], duration)
        _write_cuts(work_dir / TEXT_CUTS_FILENAME, text_cuts)

    _write_cuts(work_dir / BASE_CUTS_FILENAME, base_cuts)
    _write_cuts(work_dir / CUTS_FILENAME, cuts)

    progress(0.58, "Renderizando version corregida")
    output_path = work_dir / "cleaned.mp4"
    render_clean_video(input_path, output_path, cuts, duration, settings, progress)

    cleaned_duration = max(0.0, duration - sum(cut.duration for cut in cuts))
    progress(1.0, "Listo")
    return duration, cleaned_duration, cuts, ai_notes, output_path


def render_text_edits(
    input_path: Path,
    work_dir: Path,
    manual_cuts: list[CutSegment],
    settings: CleanerSettings,
    progress: ProgressCallback,
) -> tuple[float, float, list[CutSegment], Path]:
    require_ffmpeg()
    progress(0.5, "Preparando cortes por texto")

    duration = probe_duration(input_path)
    if duration <= 0:
        raise ProcessingError("No pude leer la duracion del video.")

    base_cut_path = work_dir / BASE_CUTS_FILENAME
    if base_cut_path.exists():
        base_cuts = _read_cuts(base_cut_path)
    else:
        base_cuts = _read_cuts(work_dir / CUTS_FILENAME)

    text_cuts = merge_cuts(manual_cuts, duration, gap=0.02)
    cuts = merge_cuts([*base_cuts, *text_cuts], duration)
    _write_cuts(work_dir / TEXT_CUTS_FILENAME, text_cuts)
    _write_cuts(work_dir / CUTS_FILENAME, cuts)

    progress(0.58, "Renderizando corte por texto")
    output_path = work_dir / "cleaned.mp4"
    render_clean_video(input_path, output_path, cuts, duration, settings, progress)

    cleaned_duration = max(0.0, duration - sum(cut.duration for cut in cuts))
    progress(1.0, "Listo")
    return duration, cleaned_duration, cuts, output_path


def render_timeline_edits(
    input_path: Path,
    work_dir: Path,
    timeline_cuts: list[CutSegment],
    settings: CleanerSettings,
    progress: ProgressCallback,
) -> tuple[float, float, list[CutSegment], Path]:
    require_ffmpeg()
    progress(0.5, "Preparando timeline")

    duration = probe_duration(input_path)
    if duration <= 0:
        raise ProcessingError("No pude leer la duracion del video.")

    cuts = merge_cuts(timeline_cuts, duration, gap=0.02)
    _write_cuts(work_dir / BASE_CUTS_FILENAME, cuts)
    _write_cuts(work_dir / CUTS_FILENAME, cuts)
    text_cut_path = work_dir / TEXT_CUTS_FILENAME
    if text_cut_path.exists():
        text_cut_path.unlink()

    progress(0.58, "Renderizando timeline")
    output_path = work_dir / "cleaned.mp4"
    render_clean_video(input_path, output_path, cuts, duration, settings, progress)

    cleaned_duration = max(0.0, duration - sum(cut.duration for cut in cuts))
    progress(1.0, "Listo")
    return duration, cleaned_duration, cuts, output_path


def export_video(work_dir: Path, fmt: str) -> Path:
    fmt = fmt.lower()
    source = work_dir / "cleaned.mp4"
    if not source.exists():
        raise ProcessingError("Todavia no existe un video procesado para exportar.")
    if fmt not in {"mp4", "mov"}:
        raise ProcessingError("Formato no soportado. Usa mp4 o mov.")

    if fmt == "mp4":
        return source
    return _copy_mov_export(work_dir, source)


def _copy_mov_export(work_dir: Path, source: Path) -> Path:
    target = work_dir / "cleaned.mov"
    if target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
        return target

    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-c",
        "copy",
        "-f",
        "mov",
        str(target),
    ]
    _run(command, "No pude generar el MOV de exportacion.")
    return target


def require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise ProcessingError("FFmpeg no esta instalado o no esta en PATH.")


def probe_duration(input_path: Path) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(input_path),
    ]
    result = _run(command, "No pude inspeccionar la duracion del video.")
    try:
        return float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ProcessingError("FFprobe no devolvio una duracion valida.") from exc


def probe_has_audio(input_path: Path) -> bool:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        str(input_path),
    ]
    result = _run(command, "No pude inspeccionar las pistas de audio.")
    return bool(result.stdout.strip())


def detect_silence_cuts(input_path: Path, duration: float, settings: CleanerSettings) -> list[CutSegment]:
    command = _build_silence_detect_command(input_path, settings)
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise ProcessingError(_clean_error(result.stderr) or "Fallo el analisis de silencios.")

    silences = _parse_silencedetect(result.stderr, duration)
    cuts: list[CutSegment] = []
    keep = settings.keep_silence_sec / 2
    for start, end in silences:
        cut_start = min(duration, max(0.0, start + keep))
        cut_end = min(duration, max(0.0, end - keep))
        if cut_end - cut_start >= 0.08:
            cuts.append(CutSegment(cut_start, cut_end, "Silencio o pausa larga"))
    return cuts


def render_clean_video(
    input_path: Path,
    output_path: Path,
    cuts: list[CutSegment],
    duration: float,
    settings: CleanerSettings,
    progress: ProgressCallback,
) -> None:
    keep_segments = invert_cuts(cuts, duration)
    if not keep_segments:
        keep_segments = [(0.0, duration)]

    filter_path = output_path.with_suffix(".filter")
    filter_path.write_text(_build_concat_filter(keep_segments), encoding="utf-8")

    command = _build_render_command(input_path, output_path, filter_path, settings)

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    for line in process.stdout:
        key, _, value = line.partition("=")
        if key == "out_time_ms":
            try:
                rendered = int(value.strip()) / 1_000_000
            except ValueError:
                continue
            progress(min(0.96, 0.58 + (rendered / max(duration, 0.01)) * 0.38), "Renderizando version corregida")

    stderr = process.stderr.read() if process.stderr else ""
    return_code = process.wait()
    if return_code != 0:
        raise ProcessingError(_clean_error(stderr) or "FFmpeg no pudo renderizar el video corregido.")


def merge_cuts(cuts: list[CutSegment], duration: float, gap: float = 0.06) -> list[CutSegment]:
    valid = sorted(
        (
            CutSegment(max(0.0, min(duration, cut.start)), max(0.0, min(duration, cut.end)), cut.reason)
            for cut in cuts
            if cut.end - cut.start > 0.03
        ),
        key=lambda cut: cut.start,
    )
    if not valid:
        return []

    merged: list[CutSegment] = [valid[0]]
    for cut in valid[1:]:
        last = merged[-1]
        if cut.start <= last.end + gap:
            reasons = last.reason if cut.reason in last.reason else f"{last.reason} + {cut.reason}"
            merged[-1] = CutSegment(last.start, max(last.end, cut.end), reasons)
        else:
            merged.append(cut)
    return merged


def invert_cuts(cuts: list[CutSegment], duration: float) -> list[tuple[float, float]]:
    keep: list[tuple[float, float]] = []
    cursor = 0.0
    for cut in cuts:
        if cut.start - cursor >= 0.05:
            keep.append((cursor, cut.start))
        cursor = max(cursor, cut.end)
    if duration - cursor >= 0.05:
        keep.append((cursor, duration))
    return keep


def _build_concat_filter(segments: list[tuple[float, float]]) -> str:
    filters: list[str] = []
    labels: list[str] = []
    for index, (start, end) in enumerate(segments):
        filters.append(
            f"[0:v:0]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[v{index}];"
            f"[0:a:0]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS[a{index}];"
        )
        labels.append(f"[v{index}][a{index}]")
    filters.append("".join(labels) + f"concat=n={len(segments)}:v=1:a=1[outv][outa]")
    return "\n".join(filters)


def _build_silence_detect_command(input_path: Path, settings: CleanerSettings) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        # Phone and screen-recorder files often include data/timecode streams.
        # Older Windows FFmpeg builds can try to decode them as "codec none".
        *AUDIO_ONLY_INPUT_OPTIONS,
        "-i",
        str(input_path),
        "-map",
        "0:a:0",
        "-af",
        f"silencedetect=noise={settings.silence_threshold_db}dB:d={settings.min_silence_sec}",
        "-f",
        "null",
        "-",
    ]


def _build_render_command(input_path: Path, output_path: Path, filter_path: Path, settings: CleanerSettings) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        *NON_MEDIA_INPUT_OPTIONS,
        "-i",
        str(input_path),
        "-filter_complex_script",
        str(filter_path),
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(settings.crf),
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


def _parse_silencedetect(stderr: str, duration: float) -> list[tuple[float, float]]:
    start_pattern = re.compile(r"silence_start:\s*(?P<start>[0-9.]+)")
    end_pattern = re.compile(r"silence_end:\s*(?P<end>[0-9.]+)")
    silences: list[tuple[float, float]] = []
    current_start: Optional[float] = None

    for line in stderr.splitlines():
        start_match = start_pattern.search(line)
        if start_match:
            current_start = float(start_match.group("start"))
            continue

        end_match = end_pattern.search(line)
        if end_match and current_start is not None:
            end = float(end_match.group("end"))
            if end > current_start:
                silences.append((current_start, min(end, duration)))
            current_start = None

    if current_start is not None and duration > current_start:
        silences.append((current_start, duration))
    return silences


def _run(command: list[str], failure_message: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise ProcessingError(_clean_error(result.stderr) or failure_message)
    return result


def _clean_error(stderr: str) -> str:
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    if not lines:
        return ""
    return lines[-1][-500:]


def _write_cuts(path: Path, cuts: list[CutSegment]) -> None:
    path.write_text(
        json.dumps([cut.to_dict() for cut in cuts], ensure_ascii=True, indent=2),
        encoding="utf-8",
    )


def _read_cuts(path: Path) -> list[CutSegment]:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(payload, list):
        return []

    cuts: list[CutSegment] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        try:
            cuts.append(CutSegment(start=float(item["start"]), end=float(item["end"]), reason=str(item["reason"])))
        except (KeyError, TypeError, ValueError):
            continue
    return cuts
