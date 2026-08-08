from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from processor.alignment import build_processing_plan
from processor.audio import audio_duration, render_chunk
from processor.extractors import extract_book
from processor.inputs import discover_book, discover_input
from processor.legacy import DEFAULT_NAMING_TEMPLATE, assign_output_names, write_legacy_manifest
from processor.packaging import build_booksync_package
from processor.text import derive_book_name, safe_name
from processor.transcription import transcribe


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Split an audiobook at chapter-safe boundaries and build a validated "
            "BookSync package from a PDF or EPUB."
        )
    )
    parser.add_argument(
        "--pdf",
        "--book",
        dest="pdf",
        type=Path,
        help="PDF or EPUB book; defaults to the only supported book in the current folder",
    )
    parser.add_argument("--audio", type=Path, help="Audiobook MP3; defaults to the only MP3 in the current folder")
    parser.add_argument("--output", type=Path, default=Path("output"))
    parser.add_argument("--model", default="small", help="Whisper model: tiny, base, small, medium, large-v3")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--minutes", type=float, default=10.0)
    parser.add_argument("--fade", type=float, default=1.5)
    parser.add_argument("--mode", choices=["smart", "chapter", "fixed"], default="smart")
    parser.add_argument("--naming-template", default=DEFAULT_NAMING_TEMPLATE)
    parser.add_argument("--window-seconds", type=int, default=300, help="Bounded transcription window size")
    parser.add_argument("--transcript-cache", type=Path, help="Reuse or create a transcript at an explicit path")
    parser.add_argument("--book-name", help="Override the book name used in output filenames")
    parser.add_argument("--language", default="en", help="BCP 47 language tag for canonical content")
    parser.add_argument("--skip-booksync", action="store_true", help="Create only the legacy MP3 export")
    parser.add_argument("--dry-run", action="store_true", help="Plan cuts without rendering audio or creating a BookSync package")
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.pdf = args.pdf or discover_book(Path.cwd())
    args.audio = args.audio or discover_input(Path.cwd(), ".mp3")
    for path in (args.pdf, args.audio):
        if not path.exists():
            parser.error(f"File not found: {path}")
    if args.minutes <= 0:
        parser.error("--minutes must be greater than zero")
    if args.window_seconds <= 0:
        parser.error("--window-seconds must be greater than zero")

    args.output.mkdir(parents=True, exist_ok=True)
    book = extract_book(args.pdf)
    book_name = safe_name(args.book_name) if args.book_name else derive_book_name(args.pdf, book.sections, book.title)
    duration = audio_duration(args.audio)
    requested_cache = args.transcript_cache or (args.output / "transcript.json")
    words = transcribe(args.audio, requested_cache, args.model, args.device, duration, args.window_seconds)

    output_transcript = args.output / "transcript.json"
    if requested_cache.resolve() != output_transcript.resolve():
        shutil.copy2(requested_cache, output_transcript)

    plan = build_processing_plan(book, words, book_name, duration, args.minutes, args.mode)
    if not plan.chapter_ranges or not plan.cuts:
        raise SystemExit("No narrated chapter ranges could be aligned. Inspect the transcript and source text.")
    assign_output_names(plan, args.naming_template, book_name)

    if not args.dry_run:
        for cut in plan.cuts:
            render_chunk(args.audio, args.output / cut.output, cut.start, cut.end, args.fade)

    write_legacy_manifest(
        args.output,
        args.pdf,
        args.audio,
        book_name,
        book,
        duration,
        plan,
        args.naming_template,
    )

    package_path: Path | None = None
    if not args.dry_run and not args.skip_booksync:
        package_path = build_booksync_package(
            output_root=args.output,
            book_path=args.pdf,
            audio_path=args.audio,
            transcript_path=output_transcript,
            book=book,
            plan=plan,
            words=words,
            book_name=book_name,
            language=args.language,
            mode=args.mode,
            minutes=args.minutes,
            naming_template=args.naming_template,
        )

    print(
        json.dumps(
            {
                "chunks": len(plan.cuts),
                "duration_minutes": round(duration / 60, 2),
                "output": str(args.output),
                "chapters_found": len(plan.chapter_ranges),
                "booksync_package": str(package_path) if package_path else None,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
