from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

from tools.publish_huggingface_package import merged_catalog
from tools.score_booksync_package import score_quality_report


class QualityScoreTests(unittest.TestCase):
    def test_publisher_can_run_as_a_direct_cli_script(self) -> None:
        project_root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [sys.executable, str(project_root / "tools" / "publish_huggingface_package.py"), "--help"],
            cwd=project_root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("usage:", result.stdout.casefold())

    def test_perfect_report_scores_one_hundred(self) -> None:
        report = {
            "title": "Example",
            "summary": {"sentence_count": 10, "exact_count": 10, "unmatched_count": 0, "coverage": 1, "chapters_requiring_review": 0},
            "timing_refinement": {"coverage": 1},
            "audio_parts": {"count": 2, "unsafe_cut_indexes": []},
        }
        score = score_quality_report(report)
        self.assertEqual(score["score"], 100)
        self.assertEqual(score["grade"], "A")

    def test_catalog_merge_is_provider_neutral_and_stable(self) -> None:
        current = {"format": "booksync-oracle-library", "schema_version": 1, "books": [{"manifest_path": "Z.booksync/manifest.json"}]}
        catalog = merged_catalog(current, "A.booksync/manifest.json")
        self.assertEqual(catalog["format"], "booksync-library")
        self.assertEqual([book["manifest_path"] for book in catalog["books"]], ["A.booksync/manifest.json", "Z.booksync/manifest.json"])


if __name__ == "__main__":
    unittest.main()
