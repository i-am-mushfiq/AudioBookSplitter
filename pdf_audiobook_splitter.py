#!/usr/bin/env python3
"""Split any audiobook into PDF-aware, approximately ten-minute MP3 files.

The audiobook and PDF do not contain timing metadata.  This tool creates that
metadata by transcribing the audiobook with faster-whisper and matching words
from the PDF to the transcript.  Cuts are then moved to a nearby sentence end
and a short audio fade is applied to avoid clicks/abrupt endings.
"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import os
import posixpath
import re
import subprocess
import sys
import zipfile
import wave
from collections import Counter
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote
from xml.etree import ElementTree


WORD_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
CHAPTER_RE = re.compile(r"^([IVXLCDM]+)\s*$", re.I)


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Chapter:
    number: str
    title: str
    pdf_page: int
    text: str


@dataclass
class Cut:
    index: int
    start: float
    end: float
    pdf_page_start: int
    pdf_page_end: int
    reason: str
    output: str
    chapter_number: str
    chapter_title: str
    part: int


def norm(text: str) -> list[str]:
    return WORD_RE.findall(text.lower().replace("—", " ").replace("-", " "))


def roman_to_int(value: str) -> int:
    if value.isdigit():
        return int(value)
    values = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    total = 0
    previous = 0
    for char in reversed(value.upper()):
        current = values[char]
        total += -current if current < previous else current
        previous = current
    return total


def safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")
    return value or "Book"


def derive_book_name(pdf_path: Path, pages: list[str]) -> str:
    """Prefer a visible PDF title, then fall back to the PDF filename."""
    first_page = pages[0] if pages else ""
    for line in (line.strip() for line in first_page.splitlines() if line.strip()):
        match = re.match(r"(.+?)\s+by\s+.+$", line, re.I)
        if match:
            return safe_name(match.group(1))
    return safe_name(pdf_path.stem)


def discover_input(directory: Path, suffix: str) -> Path:
    matches = sorted(directory.glob(f"*{suffix}"))
    if len(matches) != 1:
        names = ", ".join(path.name for path in matches) or "none"
        raise SystemExit(f"Expected exactly one {suffix} file in {directory}; found: {names}. Pass --{suffix[1:]} explicitly.")
    return matches[0]


def discover_book(directory: Path) -> Path:
    matches = sorted(list(directory.glob("*.pdf")) + list(directory.glob("*.epub")))
    if len(matches) != 1:
        names = ", ".join(path.name for path in matches) or "none"
        raise SystemExit(f"Expected exactly one PDF or EPUB in {directory}; found: {names}. Pass --pdf explicitly.")
    return matches[0]


def extract_pdf(pdf_path: Path) -> tuple[list[str], list[Chapter]]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise SystemExit("Missing pdfplumber. Install requirements.txt first.") from exc

    pages: list[str] = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            pages.append(page.extract_text() or "")

    chapters: list[Chapter] = []
    for i, page in enumerate(pages):
        lines = [line.strip() for line in page.splitlines() if line.strip()]
        for line_index, line in enumerate(lines):
            match = CHAPTER_RE.match(line)
            if match and line_index + 1 < len(lines):
                title = lines[line_index + 1]
                # The source uses uppercase chapter titles; this avoids mistaking
                # a Roman numeral in body text for a new chapter.
                if len(title) > 3 and sum(c.isupper() for c in title) >= 3:
                    # Keep the text after the numeral so chapter matching starts
                    # at the actual prose, not the repeated PDF header.
                    chapters.append(Chapter(match.group(1).upper(), title, i + 1, " ".join(lines[line_index + 1:])))
                    break
    return pages, chapters


class _EpubTextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ""
        self.heading = ""
        self._in_title = False
        self._in_heading = False
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        self._in_title = tag == "title"
        self._in_heading = tag in {"h1", "h2", "h3"}

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        if tag in {"h1", "h2", "h3"}:
            self._in_heading = False

    def handle_data(self, data):
        text = " ".join(data.split())
        if not text:
            return
        if self._in_title:
            self.title += " " + text
        if self._in_heading and not self.heading:
            self.heading = text
        self.parts.append(text)


def extract_epub(epub_path: Path) -> tuple[list[str], list[Chapter]]:
    """Read EPUB spine documents in book order using only the standard library."""
    with zipfile.ZipFile(epub_path) as archive:
        container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
        rootfile = container.find(".//{*}rootfile")
        if rootfile is None or not rootfile.attrib.get("full-path"):
            raise SystemExit("EPUB has no readable OPF package.")
        opf_path = unquote(rootfile.attrib["full-path"])
        opf_dir = posixpath.dirname(opf_path)
        opf = ElementTree.fromstring(archive.read(opf_path))
        manifest = {
            item.attrib["id"]: item.attrib.get("href", "")
            for item in opf.findall(".//{*}manifest/{*}item")
            if item.attrib.get("id")
        }
        spine_ids = [item.attrib.get("idref") for item in opf.findall(".//{*}spine/{*}itemref")]
        sections: list[str] = []
        chapters: list[Chapter] = []
        for index, item_id in enumerate(spine_ids, 1):
            href = manifest.get(item_id or "")
            if not href:
                continue
            document_path = posixpath.normpath(posixpath.join(opf_dir, unquote(href.split("#", 1)[0])))
            try:
                source = archive.read(document_path).decode("utf-8", errors="replace")
            except KeyError:
                continue
            parser = _EpubTextParser()
            parser.feed(source)
            text = " ".join(parser.parts).strip()
            if not text:
                continue
            title = (parser.heading or parser.title or f"Section {index}").strip()
            sections.append(text)
            chapters.append(Chapter(str(index), title, len(sections), text))
    if not chapters:
        raise SystemExit("EPUB contained no readable spine sections.")
    return sections, chapters


def extract_book(book_path: Path) -> tuple[list[str], list[Chapter], str]:
    if book_path.suffix.lower() == ".epub":
        pages, chapters = extract_epub(book_path)
        return pages, chapters, "epub"
    pages, chapters = extract_pdf(book_path)
    return pages, chapters, "pdf"


def _extract_audio_window(audio: Path, start: float, duration: float):
    """Decode only a bounded mono/16 kHz window into float32 samples."""
    try:
        import numpy as np
    except ImportError as exc:
        raise SystemExit("Missing numpy. Install the Conda environment first.") from exc
    result = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}",
        "-t", f"{duration:.3f}", "-i", str(audio), "-vn", "-ac", "1", "-ar", "16000",
        "-f", "wav", "pipe:1",
    ], check=True, capture_output=True)
    with wave.open(io.BytesIO(result.stdout), "rb") as reader:
        samples = np.frombuffer(reader.readframes(reader.getnframes()), dtype=np.int16)
    return samples.astype(np.float32) / 32768.0


def _write_json_checkpoint(path: Path, data: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data), encoding="utf-8")
    temporary.replace(path)


def transcribe(audio: Path, cache: Path, model_name: str, device: str, duration: float, window_seconds: int = 300) -> list[Word]:
    if cache.exists():
        data = json.loads(cache.read_text(encoding="utf-8"))
        return [Word(**item) for item in data["words"]]
    cache.parent.mkdir(parents=True, exist_ok=True)
    # faster-whisper/ctranslate2 needs cuBLAS and cuDNN on Windows. When those
    # are installed through NVIDIA's pip wheels, expose their DLL folders
    # before importing the model runtime.
    if device == "cuda" and sys.platform == "win32":
        site_packages = Path(sys.prefix) / "Lib" / "site-packages"
        for package in ("nvidia/cublas/bin", "nvidia/cudnn/bin", "nvidia/cuda_nvrtc/bin"):
            dll_dir = site_packages / package
            if dll_dir.exists():
                os.environ["PATH"] = str(dll_dir) + os.pathsep + os.environ.get("PATH", "")
                try:
                    os.add_dll_directory(str(dll_dir))
                except AttributeError:
                    pass
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise SystemExit(
            "Missing faster-whisper. Run: pip install -r requirements.txt"
        ) from exc

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
        _write_json_checkpoint(progress_path, {
            "status": "transcribing", "completed_seconds": start,
            "total_seconds": duration, "window_seconds": length,
        })
        samples = _extract_audio_window(audio, start, length)
        segments, _ = model.transcribe(
            samples, word_timestamps=True, vad_filter=True, beam_size=5,
            condition_on_previous_text=False,
        )
        for segment in segments:
            for item in segment.words or []:
                if item.start is not None and item.end is not None:
                    absolute_start = start + float(item.start)
                    absolute_end = start + float(item.end)
                    if not words or absolute_start > words[-1].start + 0.05:
                        words.append(Word(item.word.strip(), absolute_start, absolute_end))
        completed_until = start + length
        _write_json_checkpoint(partial_cache, {
            "completed_until": completed_until,
            "words": [asdict(word) for word in words],
        })

    _write_json_checkpoint(progress_path, {
        "status": "transcribed", "completed_seconds": duration,
        "total_seconds": duration, "window_seconds": window,
    })
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"words": [asdict(w) for w in words]}, indent=2), encoding="utf-8")
    partial_cache.unlink(missing_ok=True)
    return words


def find_phrase(words: list[Word], phrase: str, start_at: float = 0.0) -> float | None:
    """Find a chapter's opening phrase using tolerant ordered token matching."""
    target = norm(phrase)[:45]
    if len(target) < 5:
        return None
    best: tuple[float, float] | None = None
    for i, word in enumerate(words):
        if word.start < start_at:
            continue
        candidate = [norm(item.text)[0] for item in words[i : i + len(target)] if norm(item.text)]
        score = difflib.SequenceMatcher(None, target, candidate, autojunk=False).ratio()
        if best is None or score > best[0]:
            best = (score, word.start)
    return best[1] if best and best[0] >= 0.58 else None


def nearest_sentence_cut(words: list[Word], target: float, window: float = 75.0) -> tuple[float, str]:
    candidates: list[tuple[float, float]] = []
    for i, word in enumerate(words[:-1]):
        if abs(word.end - target) > window:
            continue
        if word.text.endswith((".", "!", "?", '.”', '!”', '?”')):
            candidates.append((abs(word.end - target), word.end))
    if candidates:
        return min(candidates)[1], "nearest sentence end"
    return target, "10-minute target (no sentence match)"


def audio_duration(audio: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(audio)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def render_chunk(audio: Path, output: Path, start: float, end: float, fade: float) -> None:
    duration = end - start
    fade_out = min(fade, max(0.1, duration / 4))
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}",
        "-i", str(audio), "-t", f"{duration:.3f}", "-map", "0:a:0", "-vn",
        "-af", f"afade=t=in:st=0:d={fade_out:.3f},afade=t=out:st={max(0, duration-fade_out):.3f}:d={fade_out:.3f}",
        "-c:a", "libmp3lame", "-b:a", "128k", str(output)
    ], check=True)


def render_filename(template: str, item: Cut, book_name: str, total_parts: int, total_chapters: int, chapter_part_count: int) -> str:
    """Render the UI's readable placeholders and replace its example counters."""
    chapter = roman_to_int(item.chapter_number)
    values = {
        "B": book_name,
        "T": str(total_parts),
        "CT": str(total_chapters),
        "PT": str(chapter_part_count),
        "I": str(item.index),
        "I2": f"{item.index:02d}",
        "C": str(chapter),
        "C2": f"{chapter:02d}",
        "P": str(item.part),
        "P2": f"{item.part:02d}",
    }
    for key, value in values.items():
        template = template.replace("{" + key + "}", value)
    # The frontend templates use 01 as a visual example. Update only known
    # counter labels, preserving book names and punctuation.
    replacements = [
        ("Chapter_01", f"Chapter_{values['C2']}"), ("Chapter01", f"Chapter{values['C2']}"),
        ("Chapter[01", f"Chapter[{values['C2']}"), ("Ch_01", f"Ch_{values['C2']}"),
        ("Ch01", f"Ch{values['C2']}"), ("C[01", f"C[{values['C2']}"), ("C01", f"C{values['C2']}"),
        ("Part_01", f"Part_{values['P2']}"), ("Part_1", f"Part_{values['P']}"),
        ("Part1", f"Part{values['P']}"), ("P[1", f"P[{values['P']}"), ("P1", f"P{values['P']}"),
        ("BookPart_01", f"BookPart_{values['I2']}"), ("WholeBook_01", f"WholeBook_{values['I2']}"),
        ("Book_01", f"Book_{values['I2']}"), ("B01", f"B{values['I2']}"),
        ("Fraction_01", f"Fraction_{values['I2']}"),
        ("001-", f"{item.index:03d}-"), ("01-", f"{values['I2']}-"), ("01of", f"{values['I2']}of"),
        ("[01|", f"[{values['I2']}|"), ("[01-", f"[{values['I2']}-"), ("01•", f"{values['I2']}•"),
        ("01·", f"{values['I2']}·"), ("01|", f"{values['I2']}|"), ("01:", f"{values['I2']}:"),
    ]
    for old, new in replacements:
        template = template.replace(old, new)
    # `|`, `:`, and other shell/path punctuation are not valid on Windows.
    template = template.replace("|", "+").replace(":", "-").replace("/", "-").replace("\\", "-")
    template = re.sub(r"[^A-Za-z0-9_\[\]().+•· -]", "", template)
    return template


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, help="PDF or EPUB book; if omitted, use the only book file in the current folder")
    parser.add_argument("--audio", type=Path, help="Audiobook; if omitted, use the only MP3 in the current folder")
    parser.add_argument("--output", type=Path, default=Path("output"))
    parser.add_argument("--model", default="small", help="Whisper model: tiny, base, small, medium, large-v3")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--minutes", type=float, default=10.0)
    parser.add_argument("--fade", type=float, default=1.5)
    parser.add_argument("--mode", choices=["smart", "chapter", "fixed"], default="smart")
    parser.add_argument("--naming-template", default="[{I2}|{T}]_{B}__C[{C2}|{CT}]__P[{P}|{PT}].mp3")
    parser.add_argument("--window-seconds", type=int, default=300, help="Bounded transcription window size")
    parser.add_argument("--book-name", help="Override the book name used in output filenames")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    args.pdf = args.pdf or discover_book(Path.cwd())
    args.audio = args.audio or discover_input(Path.cwd(), ".mp3")
    for path in (args.pdf, args.audio):
        if not path.exists():
            parser.error(f"File not found: {path}")

    pages, chapters, source_type = extract_book(args.pdf)
    book_name = safe_name(args.book_name) if args.book_name else derive_book_name(args.pdf, pages)
    duration = audio_duration(args.audio)
    cache = args.output / "transcript.json"
    words = transcribe(args.audio, cache, args.model, args.device, duration, args.window_seconds)

    # Match the beginning of every PDF page to the transcript. This gives the
    # manifest a useful page range even when a cut lands between chapters.
    page_times: list[tuple[int, float]] = []
    cursor = 0.0
    for page_number, page_text in enumerate(pages, 1):
        page_lines = [line.strip() for line in page_text.splitlines() if line.strip()]
        if source_type == "pdf" and page_lines and page_lines[0].lower().startswith(book_name.replace("_", " ").lower()):
            page_lines = page_lines[1:]
        page_start = find_phrase(words, " ".join(page_lines), cursor)
        if page_start is not None:
            cursor = page_start
            page_times.append((page_number, page_start))

    chapter_times: list[tuple[Chapter, float]] = []
    cursor = 0.0
    for chapter in chapters:
        # The chapter title line is a much stronger anchor than a whole PDF
        # page, especially when the page begins with a continuation from the
        # previous chapter.
        found = find_phrase(words, chapter.title, cursor)
        if found is None:
            found = find_phrase(words, chapter.text.replace("\n", " "), cursor)
        if found is not None:
            cursor = found
        chapter_times.append((chapter, cursor))

    # Chapters are hard boundaries: build the ten-minute parts independently
    # inside each chapter so no output file ever contains two chapters.
    chapter_ranges: list[tuple[Chapter, float, float]] = []
    for index, (chapter, chapter_time) in enumerate(chapter_times):
        start = 0.0 if index == 0 else chapter_time
        end = chapter_times[index + 1][1] if index + 1 < len(chapter_times) else duration
        if end > start:
            chapter_ranges.append((chapter, start, end))

    cuts: list[Cut] = []
    target = args.minutes * 60
    chunk_number = 1
    for chapter, chapter_start, chapter_end in chapter_ranges:
        current = chapter_start
        part = 1
        while args.mode != "chapter" and chapter_end - current > target + 45:
            cut, reason = nearest_sentence_cut(words, current + target)
            cut = max(current + 60, min(chapter_end - 30, cut))
            cuts.append(Cut(chunk_number, current, cut, 1, 1, reason, "", chapter.number, chapter.title, part))
            current = cut
            chunk_number += 1
            part += 1
        cuts.append(Cut(chunk_number, current, chapter_end, 1, 1, "chapter boundary" if chapter_end < duration else "final chunk", "", chapter.number, chapter.title, part))
        chunk_number += 1

    def page_at(time: float) -> int:
        current = 1
        for page_number, page_time in page_times:
            if page_time <= time:
                current = page_number
        # Approximate within a chapter using word progress. This is useful for
        # the manifest even when a cut falls mid-page.
        return current

    args.output.mkdir(parents=True, exist_ok=True)
    manifest: list[Cut] = []
    total_chapters = len(chapter_ranges)
    total_parts = len(cuts)
    chapter_part_counts = Counter(item.chapter_number for item in cuts)
    for item in cuts:
        filename = render_filename(args.naming_template, item, book_name, total_parts, total_chapters, chapter_part_counts[item.chapter_number])
        item.output = filename
        item.pdf_page_start = page_at(item.start)
        item.pdf_page_end = page_at(max(item.start, item.end - 0.1))
        manifest.append(item)
        if not args.dry_run:
            render_chunk(args.audio, args.output / filename, item.start, item.end, args.fade)

    report = {
        "book_name": book_name, "source_type": source_type, "total_chapters": total_chapters, "total_parts": total_parts,
        "filename_pattern": args.naming_template,
        "source_pdf": str(args.pdf), "source_audio": str(args.audio),
        "audio_duration_seconds": duration, "pdf_pages": len(pages),
        "chapters": [asdict(c) for c, _ in chapter_times],
        "chapter_audio_starts": [{"number": c.number, "title": c.title, "pdf_page": c.pdf_page, "audio_start": t} for c, t in chapter_times],
        "chunks": [asdict(c) for c in manifest],
    }
    (args.output / "manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"chunks": len(manifest), "duration_minutes": round(duration / 60, 2), "output": str(args.output), "chapters_found": len(chapters)}, indent=2))


if __name__ == "__main__":
    main()
