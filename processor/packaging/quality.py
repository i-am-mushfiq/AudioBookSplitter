from __future__ import annotations

import html
from pathlib import Path
from typing import Any

from processor.models import ProcessingPlan


def unmatched_runs(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    start: int | None = None
    for index, entry in enumerate(entries):
        if entry["alignment"] == "unmatched" and start is None:
            start = index
        if entry["alignment"] != "unmatched" and start is not None:
            runs.append(_run_record(entries, start, index - 1))
            start = None
    if start is not None:
        runs.append(_run_record(entries, start, len(entries) - 1))
    return runs


def _run_record(entries: list[dict[str, Any]], start: int, end: int) -> dict[str, Any]:
    return {
        "start_ordinal": entries[start]["ordinal"],
        "end_ordinal": entries[end]["ordinal"],
        "length": end - start + 1,
        "first_text": entries[start]["text"][:240],
        "last_text": entries[end]["text"][:240],
    }


def build_quality_report(
    *,
    title: str,
    backend_name: str,
    chapter_entries: list[tuple[dict[str, Any], list[dict[str, Any]]]],
    plan: ProcessingPlan,
) -> dict[str, Any]:
    chapter_reports: list[dict[str, Any]] = []
    all_entries: list[dict[str, Any]] = []
    for chapter, entries in chapter_entries:
        all_entries.extend(entries)
        exact = sum(entry["alignment"] == "exact" for entry in entries)
        approximate = sum(entry["alignment"] == "approximate" for entry in entries)
        unmatched = sum(entry["alignment"] == "unmatched" for entry in entries)
        aligned = exact + approximate
        runs = unmatched_runs(entries)
        chapter_reports.append(
            {
                "chapter_id": chapter["id"],
                "index": chapter["index"],
                "title": chapter["title"],
                "sentence_count": len(entries),
                "exact_count": exact,
                "approximate_count": approximate,
                "unmatched_count": unmatched,
                "coverage": aligned / len(entries) if entries else 0.0,
                "longest_unmatched_run": max((run["length"] for run in runs), default=0),
                "unmatched_runs": runs,
                "requires_review": approximate > 0 or any(run["length"] >= 3 for run in runs),
            }
        )

    exact_total = sum(entry["alignment"] == "exact" for entry in all_entries)
    approximate_total = sum(entry["alignment"] == "approximate" for entry in all_entries)
    unmatched_total = sum(entry["alignment"] == "unmatched" for entry in all_entries)
    token_refined_total = sum("token-refined" in entry.get("reasons", []) for entry in all_entries)
    proportional_total = sum("proportional-timing" in entry.get("reasons", []) for entry in all_entries)
    sentence_total = len(all_entries)
    durations = [(cut.end - cut.start) / 60 for cut in plan.cuts]
    safe_reasons = {"nearest sentence end", "nearest speech pause", "chapter boundary", "final chunk"}
    unsafe_cuts = [cut.index for cut in plan.cuts if cut.reason not in safe_reasons]
    return {
        "format": "booksync-quality-report",
        "schema_version": 1,
        "title": title,
        "alignment_backend": backend_name,
        "timing_source": "asr-word-timestamps",
        "forced_alignment_applied": False,
        "manual_timing_evaluation": {
            "completed": False,
            "median_start_error_ms": None,
            "p95_start_error_ms": None,
        },
        "timing_refinement": {
            "token_refined_count": token_refined_total,
            "proportional_count": proportional_total,
            "coverage": token_refined_total / sentence_total if sentence_total else 0.0,
        },
        "summary": {
            "sentence_count": sentence_total,
            "exact_count": exact_total,
            "approximate_count": approximate_total,
            "unmatched_count": unmatched_total,
            "coverage": (exact_total + approximate_total) / sentence_total if sentence_total else 0.0,
            "chapters_requiring_review": sum(chapter["requires_review"] for chapter in chapter_reports),
        },
        "audio_parts": {
            "count": len(plan.cuts),
            "minimum_minutes": min(durations) if durations else 0.0,
            "maximum_minutes": max(durations) if durations else 0.0,
            "mean_minutes": sum(durations) / len(durations) if durations else 0.0,
            "parts_under_four_minutes": sum(duration < 4 for duration in durations),
            "unsafe_cut_indexes": unsafe_cuts,
        },
        "chapters": chapter_reports,
    }


def write_alignment_review(
    path: Path,
    title: str,
    chapter_entries: list[tuple[dict[str, Any], list[dict[str, Any]]]],
) -> None:
    sections: list[str] = []
    for chapter, entries in chapter_entries:
        rows: list[str] = []
        for entry in entries:
            locator = entry["audio_locator"]
            time = "—" if locator is None else f"{locator['global_start_ms'] / 1000:.2f}s"
            reasons = ", ".join(entry.get("reasons", []))
            rows.append(
                "<tr class=\"{state}\"><td>{ordinal}</td><td>{state}</td><td>{confidence:.3f}</td>"
                "<td>{time}</td><td>{text}</td><td>{reasons}</td></tr>".format(
                    state=entry["alignment"],
                    ordinal=entry["ordinal"],
                    confidence=entry["confidence"],
                    time=html.escape(time),
                    text=html.escape(entry["text"]),
                    reasons=html.escape(reasons),
                )
            )
        sections.append(
            f"<section><h2>{chapter['index']:02d} · {html.escape(chapter['title'] or chapter['label'])}</h2>"
            "<table><thead><tr><th>#</th><th>State</th><th>Confidence</th><th>Audio</th>"
            f"<th>Sentence</th><th>Diagnostics</th></tr></thead><tbody>{''.join(rows)}</tbody></table></section>"
        )

    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} alignment review</title>
<style>
body{{font:14px/1.5 system-ui,sans-serif;margin:0;background:#f5f5f5;color:#111}}main{{max-width:1400px;margin:auto;padding:32px}}
h1{{font-size:32px}}section{{background:white;margin:24px 0;padding:20px;border-radius:12px;overflow:auto}}
table{{border-collapse:collapse;width:100%}}th,td{{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}}
th{{position:sticky;top:0;background:#111;color:white}}tr.approximate{{background:#fff4cc}}tr.unmatched{{background:#ffe3e3}}
td:nth-child(1),td:nth-child(3),td:nth-child(4){{white-space:nowrap}}
</style></head><body><main><h1>{html.escape(title)}</h1><p>Yellow rows are approximate; red rows require review.</p>{''.join(sections)}</main></body></html>"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(document, encoding="utf-8")
