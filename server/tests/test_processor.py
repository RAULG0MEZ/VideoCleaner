from pathlib import Path

from app.processor import _build_concat_filter, _build_render_command, _build_silence_detect_command
from app.schemas import CleanerSettings


def test_concat_filter_targets_first_video_and_audio_streams() -> None:
    filter_script = _build_concat_filter([(0.0, 1.25), (2.5, 4.0)])

    assert "[0:v:0]trim=start=0.000:end=1.250" in filter_script
    assert "[0:a:0]atrim=start=0.000:end=1.250" in filter_script
    assert "[0:v]trim" not in filter_script
    assert "[0:a]atrim" not in filter_script


def test_silence_detect_ignores_non_audio_streams() -> None:
    command = _build_silence_detect_command(Path("source.mp4"), CleanerSettings())
    input_index = command.index("-i")
    map_index = command.index("-map")

    assert command[input_index - 3 : input_index] == ["-vn", "-sn", "-dn"]
    assert command[map_index + 1] == "0:a:0"


def test_render_ignores_data_streams_and_drops_metadata() -> None:
    command = _build_render_command(Path("source.mp4"), Path("cleaned.mp4"), Path("cleaned.filter"), CleanerSettings())
    input_index = command.index("-i")

    assert command[input_index - 2 : input_index] == ["-sn", "-dn"]
    assert "[outv]" in command
    assert "[outa]" in command
    assert command[command.index("-map_metadata") + 1] == "-1"
    assert command[command.index("-map_chapters") + 1] == "-1"
