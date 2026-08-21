#!/usr/bin/env python3
"""Create a concise, reproducible quality scorecard for a BookSync package."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def score_quality_report(report: dict[str, Any]) -> dict[str, Any]:
    summary = report["summary"]
    timing = report["timing_refinement"]
    parts = report["audio_parts"]
    sentences = max(1, int(summary["sentence_count"]))
    coverage = float(summary["coverage"])
    exact_ratio = int(summary["exact_count"]) / sentences
    timing_coverage = float(timing["coverage"])
    part_count = max(1, int(parts["count"]))
    safe_cut_ratio = 1 - min(1.0, len(parts["unsafe_cut_indexes"]) / part_count)
    score = round(100 * (0.55 * coverage + 0.25 * exact_ratio + 0.15 * timing_coverage + 0.05 * safe_cut_ratio), 1)
    grade = "A" if score >= 93 else "B" if score >= 85 else "C" if score >= 75 else "D" if score >= 60 else "F"
    review_chapters = int(summary["chapters_requiring_review"])
    return {
        "format": "booksync-scorecard",
        "schema_version": 1,
        "title": report["title"],
        "score": score,
        "grade": grade,
        "metrics": {
            "sentence_coverage": round(coverage, 6),
            "exact_alignment_ratio": round(exact_ratio, 6),
            "word_timing_coverage": round(timing_coverage, 6),
            "safe_cut_ratio": round(safe_cut_ratio, 6),
            "chapters_requiring_review": review_chapters,
            "sentence_count": int(summary["sentence_count"]),
            "unmatched_sentences": int(summary["unmatched_count"]),
            "audio_parts": int(parts["count"]),
        },
        "interpretation": "Excellent automated alignment" if grade == "A" else "Good automated alignment; review flagged chapters" if grade == "B" else "Usable with manual review" if grade == "C" else "Manual correction recommended",
        "limitations": [
            "This is an automated structural score, not a human listening test.",
            "Manual timing error evaluation has not been completed.",
            "Approximate sentence matches can still sound correct and are conservatively flagged.",
        ],
    }


def score_package(package: Path, output: Path | None = None) -> tuple[Path, dict[str, Any]]:
    package = package.resolve()
    report_path = package / "reports" / "quality-report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    scorecard = score_quality_report(report)
    destination = (output or package.parent / f"{package.stem}-scorecard.json").resolve()
    destination.write_text(json.dumps(scorecard, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return destination, scorecard


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    destination, scorecard = score_package(args.package, args.output)
    print(json.dumps({"score": scorecard["score"], "grade": scorecard["grade"], "scorecard": str(destination)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
