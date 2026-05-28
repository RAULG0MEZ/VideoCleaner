from __future__ import annotations

import json
import os
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Union

from .schemas import CleanerSettings, CutSegment


REPETITION_MAX_GAP_SEC = 1.6
CUT_PADDING_SEC = 0.04


@dataclass
class DialogueCleanupResult:
    cuts: list[CutSegment] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    word_count: int = 0


@dataclass
class TranscriptResult:
    words: list[Word] = field(default_factory=list)
    language: str = ""
    duration: Optional[float] = None
    notes: list[str] = field(default_factory=list)
    available: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "language": self.language,
            "duration": self.duration,
            "notes": self.notes,
            "words": [word.to_dict() for word in self.words],
        }


FILLER_WORDS = {
    "ah",
    "eh",
    "em",
    "mmm",
    "mm",
    "este",
    "estee",
    "pues",
    "bueno",
    "ok",
    "okay",
    "tipo",
}

FILLER_PHRASES = {
    ("o", "sea"),
    ("es", "decir"),
    ("digamos", "que"),
}


def suggest_dialogue_cuts(
    media_path: Path,
    work_dir: Path,
    settings: CleanerSettings,
) -> DialogueCleanupResult:
    if not settings.enable_ai_cleanup:
        return DialogueCleanupResult()

    transcript = transcribe_dialogue(media_path, work_dir, settings)
    cuts = suggest_cuts_from_words(transcript.words) if transcript.words else []
    notes = list(transcript.notes)
    if not transcript.words and not notes:
        notes.append("Whisper no devolvio palabras con timestamps para analizar redundancias.")
    elif transcript.words and not cuts:
        notes.append("Whisper transcribio el dialogo, pero no encontro muletillas o repeticiones claras.")

    (work_dir / "ai_suggestions.json").write_text(
        json.dumps(
            {
                "notes": notes,
                "word_count": len(transcript.words),
                "cuts": [cut.to_dict() for cut in cuts],
            },
            ensure_ascii=True,
            indent=2,
        ),
        encoding="utf-8",
    )
    return DialogueCleanupResult(cuts=cuts, notes=notes, word_count=len(transcript.words))


def transcribe_dialogue(
    media_path: Path,
    work_dir: Path,
    settings: CleanerSettings,
) -> TranscriptResult:
    if os.getenv("DISABLE_WHISPER") == "1":
        note = "Limpieza por dialogo desactivada por DISABLE_WHISPER=1."
        result = TranscriptResult(notes=[note], language=settings.language, available=False)
        _write_transcript(work_dir, result)
        return result

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        note = "La transcripcion necesita faster-whisper. Instala el extra server[ai] y vuelve a procesar."
        result = TranscriptResult(notes=[note], language=settings.language, available=False)
        _write_transcript(work_dir, result)
        return result

    model_name = os.getenv("WHISPER_MODEL", "base")
    device = os.getenv("WHISPER_DEVICE", "auto")
    compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "default")
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    language = None if settings.language in {"", "auto"} else settings.language

    segments, info = model.transcribe(
        str(media_path),
        language=language,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
    )

    words: list[Word] = []
    for segment in segments:
        for word in segment.words or []:
            normalized = _normalize_word(word.word)
            if not normalized:
                continue
            words.append(Word(text=word.word.strip(), normalized=normalized, start=float(word.start), end=float(word.end)))

    notes: list[str] = []
    if not words:
        notes.append("Whisper no devolvio palabras con timestamps para analizar redundancias.")

    result = TranscriptResult(
        words=words,
        language=getattr(info, "language", settings.language),
        duration=getattr(info, "duration", None),
        notes=notes,
        available=True,
    )
    _write_transcript(work_dir, result)
    return result


@dataclass
class Word:
    text: str
    normalized: str
    start: float
    end: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "normalized": self.normalized,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
        }


def suggest_cuts_from_words(raw_words: list[Union[Word, dict[str, Any]]]) -> list[CutSegment]:
    words = [_coerce_word(word) for word in raw_words]
    cuts: list[CutSegment] = []
    phrase_cuts, covered_indexes = _repeated_phrase_cuts(words)
    cuts.extend(phrase_cuts)
    cuts.extend(_repeated_word_cuts(words, covered_indexes))
    cuts.extend(_filler_word_cuts(words, covered_indexes))
    return cuts


def _filler_word_cuts(words: list[Word], covered_indexes: set[int]) -> list[CutSegment]:
    cuts: list[CutSegment] = []
    for index, word in enumerate(words):
        if index in covered_indexes:
            continue
        normalized = word.normalized
        if normalized in FILLER_WORDS:
            cuts.append(_word_cut(word, f"Muletilla: {word.text}"))

        for phrase in FILLER_PHRASES:
            phrase_len = len(phrase)
            window = words[index : index + phrase_len]
            if len(window) != phrase_len:
                continue
            if any((index + offset) in covered_indexes for offset in range(phrase_len)):
                continue
            if tuple(item.normalized for item in window) == phrase:
                cuts.append(
                    CutSegment(
                        start=max(0.0, window[0].start - CUT_PADDING_SEC),
                        end=window[-1].end + CUT_PADDING_SEC,
                        reason=f"Muletilla: {' '.join(item.text for item in window)}",
                    )
                )
    return cuts


def _repeated_phrase_cuts(words: list[Word]) -> tuple[list[CutSegment], set[int]]:
    cuts: list[CutSegment] = []
    covered_indexes: set[int] = set()
    index = 0
    max_phrase_len = min(6, max(2, len(words) // 2))

    while index < len(words):
        matched = False
        for phrase_len in range(max_phrase_len, 1, -1):
            first = words[index : index + phrase_len]
            second = words[index + phrase_len : index + phrase_len * 2]
            if len(first) != phrase_len or len(second) != phrase_len:
                continue
            if not _same_phrase(first, second):
                continue
            if not _close_enough(first[-1], second[0]):
                continue

            repeat_end = index + phrase_len * 2
            while repeat_end + phrase_len <= len(words):
                previous_phrase = words[repeat_end - phrase_len : repeat_end]
                next_phrase = words[repeat_end : repeat_end + phrase_len]
                if not _same_phrase(first, next_phrase):
                    break
                if not _close_enough(previous_phrase[-1], next_phrase[0]):
                    break
                repeat_end += phrase_len

            repeated_words = words[index + phrase_len : repeat_end]
            for repeated_index in range(index + phrase_len, repeat_end):
                covered_indexes.add(repeated_index)
            cuts.append(
                CutSegment(
                    start=max(0.0, repeated_words[0].start - CUT_PADDING_SEC),
                    end=repeated_words[-1].end + CUT_PADDING_SEC,
                    reason=f"Frase repetida: {' '.join(word.text for word in first)}",
                )
            )
            index = repeat_end
            matched = True
            break
        if not matched:
            index += 1

    return cuts, covered_indexes


def _repeated_word_cuts(words: list[Word], covered_indexes: set[int]) -> list[CutSegment]:
    cuts: list[CutSegment] = []
    index = 0
    while index < len(words):
        if index in covered_indexes:
            index += 1
            continue

        end = index + 1
        while end < len(words):
            if end in covered_indexes:
                break
            if words[end].normalized != words[index].normalized:
                break
            if not _close_enough(words[end - 1], words[end]):
                break
            end += 1

        if end - index > 1:
            repeated_words = words[index + 1 : end]
            for repeated_index in range(index + 1, end):
                covered_indexes.add(repeated_index)
            cuts.append(
                CutSegment(
                    start=max(0.0, repeated_words[0].start - CUT_PADDING_SEC),
                    end=repeated_words[-1].end + CUT_PADDING_SEC,
                    reason=f"Palabra repetida: {words[index].text} x{end - index}",
                )
            )
        index = max(end, index + 1)
    return cuts


def _word_cut(word: Word, reason: str) -> CutSegment:
    return CutSegment(
        start=max(0.0, word.start - CUT_PADDING_SEC),
        end=word.end + CUT_PADDING_SEC,
        reason=reason,
    )


def _coerce_word(word: Union[Word, dict[str, Any]]) -> Word:
    if isinstance(word, Word):
        return word
    text = str(word.get("text", "")).strip()
    normalized = str(word.get("normalized") or _normalize_word(text))
    return Word(text=text, normalized=normalized, start=float(word["start"]), end=float(word["end"]))


def _same_phrase(first: list[Word], second: list[Word]) -> bool:
    return [word.normalized for word in first] == [word.normalized for word in second]


def _close_enough(previous: Word, current: Word) -> bool:
    return 0 <= current.start - previous.end <= REPETITION_MAX_GAP_SEC


def _normalize_word(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value.lower())
    without_marks = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return re.sub(r"[^a-z0-9]+", "", without_marks)


def _write_ai_note(work_dir: Path, message: str) -> None:
    (work_dir / "ai_suggestions.json").write_text(
        json.dumps({"skipped": True, "notes": [message], "cuts": []}, ensure_ascii=True, indent=2),
        encoding="utf-8",
    )


def _write_transcript(work_dir: Path, result: TranscriptResult) -> None:
    (work_dir / "transcript.json").write_text(
        json.dumps(result.to_payload(), ensure_ascii=True, indent=2),
        encoding="utf-8",
    )
