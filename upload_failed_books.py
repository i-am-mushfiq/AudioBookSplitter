#!/usr/bin/env python3
"""Upload the two books that failed in the dashboard pipeline."""
import subprocess, sys, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PACKAGES = [
    ROOT / "local-data/books/_operations/dashboard-output/The_Intelligent_Investor_The_Definitive_Book_On_Value_Investing_Revised_Edition/The_Intelligent_Investor_The_Definitive_Book_On_Va.booksync",
    ROOT / "local-data/books/_operations/dashboard-output/Martin_Kleppmann_Designing_Data_Intensive_Applicat/Designing_Data_Intensive_Applications.booksync",
]

REPO = "mdrahman/booksync-library"

def upload(package: Path):
    log = ROOT / f"upload_{package.stem}.log"
    print(f"[START] {package.name} -> {log.name}", flush=True)
    cmd = [sys.executable, str(ROOT / "tools/publish_huggingface_package.py"), str(package), "--repo", REPO]
    with log.open("w", encoding="utf-8") as f:
        result = subprocess.run(cmd, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, text=True)
    status = "SUCCESS" if result.returncode == 0 else f"FAILED (exit {result.returncode})"
    print(f"[{status}] {package.name}", flush=True)

threads = []
for pkg in PACKAGES:
    if not pkg.exists():
        print(f"[SKIP] Package not found: {pkg}", flush=True)
        continue
    if not (pkg / "manifest.json").is_file():
        print(f"[SKIP] Incomplete package (no manifest.json): {pkg}", flush=True)
        continue
    t = threading.Thread(target=upload, args=(pkg,), daemon=False)
    threads.append(t)
    t.start()

for t in threads:
    t.join()

print("All uploads finished.", flush=True)
