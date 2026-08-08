from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import wave
from dataclasses import asdict
from pathlib import Path

from processor.models import Word


def extract_audio_window(audio: Path, start: float, duration: float):
    """Decode only a bounded mono/16 kHz window into float32 samples."""
    try:
        import numpy as np
    except ImportError as exc:
        raise SystemExit("Missing numpy. Install the Conda environment first.") from exc
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(audio),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    with wave.open(io.BytesIO(result.stdout), "rb") as reader:
        samples = np.frombuffer(reader.readframes(reader.getnframes()), dtype=np.int16)
    return samples.astype(np.float32) / 32768.0


def write_json_checkpoint(path: Path, data: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data), encoding="utf-8")
    temporary.replace(path)


def load_transcript(path: Path) -> list[Word]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [Word(**item) for item in data["words"]]


def _configure_cuda_dlls() -> None:
    if sys.platform != "win32":
        return
    site_packages = Path(sys.prefix) / "Lib" / "site-packages"
    for package in ("nvidia/cublas/bin", "nvidia/cudnn/bin", "nvidia/cuda_nvrtc/bin"):
        dll_dir = site_packages / package
        if not dll_dir.exists():
            continue
        os.environ["PATH"] = str(dll_dir) + os.pathsep + os.environ.get("PATH", "")
        try:
            os.add_dll_directory(str(dll_dir))
        except AttributeError:
            pass


def transcribe(
    audio: Path,
    cache: Path,
    model_name: str,
    device: str,
    duration: float,
    window_seconds: int = 300,
) -> list[Word]:
    if cache.exists():
        return load_transcript(cache)
    cache.parent.mkdir(parents=True, exist_ok=True)
    if device == "cuda":
        _configure_cuda_dlls()
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise SystemExit("Missing faster-whisper. Run: pip install -r requirements.txt") from exc

    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    partial_cache = cache.with_name(cache.stem + ".partial.json")
    progress_path = cache.with_name("progress.json")
    words: list[Word] = []
    completed_until = 0.0
    if partial_cache.exists():
        partial = json.loads(partial_cache.read_text(encoding="utf-8"))
        words = [Word(**item) for item in partial.get("words", [])]
        completed_until = float(partial.get("completed_until", 0.0))

    window = float(window_seconds)
    while completed_until < duration - 0.05:
        start = completed_until
        length = min(window, duration - start)
        write_json_checkpoint(
            progress_path,
            {
                "status": "transcribing",
                "completed_seconds": start,
                "total_seconds": duration,
                "window_seconds": length,
            },
        )
        samples = extract_audio_window(audio, start, length)
        segments, _ = model.transcribe(
            samples,
            word_timestamps=True,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )
        for segment in segments:
            for item in segment.words or []:
                if item.start is None or item.end is None:
                    continue
                absolute_start = start + float(item.start)
                absolute_end = start + float(item.end)
                if not words or absolute_start > words[-1].start + 0.05:
                    words.append(Word(item.word.strip(), absolute_start, absolute_end))
        completed_until = start + length
        write_json_checkpoint(
            partial_cache,
            {
                "completed_until": completed_until,
                "words": [asdict(word) for word in words],
            },
        )

    write_json_checkpoint(
        progress_path,
        {
            "status": "transcribed",
            "completed_seconds": duration,
            "total_seconds": duration,
            "window_seconds": window,
        },
    )
    cache.write_text(json.dumps({"words": [asdict(word) for word in words]}, indent=2), encoding="utf-8")
    partial_cache.unlink(missing_ok=True)
    return words
