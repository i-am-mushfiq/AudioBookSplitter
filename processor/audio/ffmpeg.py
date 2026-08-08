from __future__ import annotations

import subprocess
from pathlib import Path


def audio_duration(audio: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(audio),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def render_chunk(audio: Path, output: Path, start: float, end: float, fade: float) -> None:
    duration = end - start
    fade_duration = min(fade, max(0.1, duration / 4))
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(audio),
            "-t",
            f"{duration:.3f}",
            "-map",
            "0:a:0",
            "-vn",
            "-af",
            (
                f"afade=t=in:st=0:d={fade_duration:.3f},"
                f"afade=t=out:st={max(0, duration - fade_duration):.3f}:d={fade_duration:.3f}"
            ),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            str(output),
        ],
        check=True,
    )
