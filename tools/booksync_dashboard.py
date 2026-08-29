import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from rich.console import Console
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn
from rich.table import Table
from rich.text import Text

# Paths
ROOT = Path(__file__).resolve().parents[1]
UNPROCESSED_DIR = ROOT / "local-data" / "books" / "not-in-hugging-face" / "unprocessed"
PROCESSING_DIR = ROOT / "local-data" / "books" / "not-in-hugging-face" / "processing"
COMPLETED_DIR = ROOT / "local-data" / "books" / "in-hugging-face"
OUTPUT_DIR = ROOT / "local-data" / "books" / "_operations" / "dashboard-output"

console = Console()

class Dashboard:
    def __init__(self):
        self.books = {}  # id -> {title, status, percent, message, workload}
        self.gpu_book = None
        self.cpu_book = None
        self.logs = []
        self.uploads = {}
        
    def generate_layout(self) -> Layout:
        layout = Layout()
        layout.split_column(
            Layout(name="header", size=3),
            Layout(name="main"),
            Layout(name="logs", size=8),
        )
        layout["main"].split_row(
            Layout(name="tasks"),
            Layout(name="uploads", size=50)
        )
        
        # Header
        header_text = f"BookSync Batch Dashboard | GPU: {self.gpu_book or 'Idle'} | CPU: {self.cpu_book or 'Idle'}"
        layout["header"].update(Panel(Text(header_text, style="bold white on blue"), title="Status"))
        
        # Tasks Table
        table = Table(show_header=True, expand=True)
        table.add_column("Book Title", style="cyan", width=30)
        table.add_column("Status", style="magenta")
        table.add_column("Workload", style="green")
        table.add_column("Progress", width=20)
        table.add_column("Message")
        
        for book_id, info in self.books.items():
            progress_bar = f"[{info['percent']}%]"
            if info['percent'] == 100:
                progress_bar = "[bold green]Done[/bold green]"
            table.add_row(info['title'], info['status'], info['workload'], progress_bar, info['message'])
            
        layout["tasks"].update(Panel(table, title="Pipeline Tasks"))
        
        # Uploads Table
        upload_table = Table(show_header=True, expand=True)
        upload_table.add_column("Book Title", style="cyan")
        upload_table.add_column("Upload Status", style="magenta")
        upload_table.add_column("Progress")
        
        for book_id, info in self.uploads.items():
            progress_bar = f"[{info['percent']}%]"
            upload_table.add_row(info['title'], info['status'], progress_bar)
            
        layout["uploads"].update(Panel(upload_table, title="Hugging Face Uploads"))
        
        # Logs
        log_text = "\n".join(self.logs[-6:])
        layout["logs"].update(Panel(log_text, title="Recent Logs"))
        
        return layout

def parse_events(dashboard: Dashboard, stdout_queue: queue.Queue):
    while True:
        try:
            line = stdout_queue.get(timeout=0.1)
            if line is None:
                break
            
            if line.startswith("BOOKSYNC_BATCH_EVENT "):
                event = json.loads(line[len("BOOKSYNC_BATCH_EVENT "):])
                event_type = event.get("type")
                
                if event_type == "started":
                    for b in event.get("books", []):
                        dashboard.books[b["bookId"]] = {
                            "title": b["title"],
                            "status": "Queued",
                            "percent": 0,
                            "message": "Waiting",
                            "workload": "wait"
                        }
                elif event_type == "book":
                    book_id = event.get("bookId")
                    if book_id in dashboard.books:
                        dashboard.books[book_id]["status"] = event.get("stage", "")
                        dashboard.books[book_id]["percent"] = event.get("percent", 0)
                        dashboard.books[book_id]["message"] = event.get("message", "")
                        dashboard.books[book_id]["workload"] = event.get("workload", "")
                elif event_type == "upload":
                    book_id = event.get("bookId")
                    if book_id not in dashboard.uploads:
                        dashboard.uploads[book_id] = {"title": event.get("title", book_id), "status": "", "percent": 0}
                    dashboard.uploads[book_id]["status"] = event.get("stage", "")
                    dashboard.uploads[book_id]["percent"] = event.get("percent", 0)
                elif event_type == "scheduler":
                    dashboard.gpu_book = event.get("gpuBook", dashboard.gpu_book)
                    dashboard.cpu_book = event.get("cpuBook", dashboard.cpu_book)
                elif event_type == "log":
                    dashboard.logs.append(f"{event.get('source')}: {event.get('message')}")
        except queue.Empty:
            continue
        except Exception as e:
            dashboard.logs.append(f"Error parsing event: {e}")

def enqueue_output(out, q):
    for line in iter(out.readline, ''):
        q.put(line.strip())
    out.close()

def main():
    parser = argparse.ArgumentParser(description="Live Dashboard for BookSync")
    parser.add_argument("--limit", type=int, default=3, help="Number of books to process")
    args = parser.parse_args()

    # Move books to processing
    UNPROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSING_DIR.mkdir(parents=True, exist_ok=True)
    COMPLETED_DIR.mkdir(parents=True, exist_ok=True)
    
    processing_books = [d for d in PROCESSING_DIR.iterdir() if d.is_dir()]
    
    if len(processing_books) < args.limit:
        unprocessed_books = [d for d in UNPROCESSED_DIR.iterdir() if d.is_dir()]
        to_process = sorted(unprocessed_books)[:args.limit - len(processing_books)]
        if to_process:
            console.print(f"Moving {len(to_process)} books to processing folder...")
            for book in to_process:
                dest = PROCESSING_DIR / book.name
                shutil.move(str(book), str(dest))
                processing_books.append(dest)
                
    if not processing_books:
        console.print("[red]No books found to process.[/red]")
        return
        
    dashboard = Dashboard()
    
    cmd = [
        "conda", "run", "--no-capture-output", "-n", "animal-farm-splitter",
        "python", str(ROOT / "tools" / "booksync_batch_pipeline.py"),
        "--source", str(PROCESSING_DIR),
        "--output", str(OUTPUT_DIR),
        "--auto-upload"
    ]
    
    process = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8"
    )
    
    q = queue.Queue()
    t = threading.Thread(target=enqueue_output, args=(process.stdout, q))
    t.daemon = True
    t.start()
    
    event_thread = threading.Thread(target=parse_events, args=(dashboard, q))
    event_thread.daemon = True
    event_thread.start()
    
    try:
        with Live(dashboard.generate_layout(), refresh_per_second=4, screen=True) as live:
            while process.poll() is None:
                live.update(dashboard.generate_layout())
                time.sleep(0.25)
            # Final update
            live.update(dashboard.generate_layout())
    except KeyboardInterrupt:
        process.terminate()
        
    q.put(None)
    event_thread.join(timeout=2)
    
    console.print(f"Pipeline finished with code {process.returncode}")
    
    # Move successfully processed and uploaded to completed
    for book_id, info in dashboard.books.items():
        upload_info = dashboard.uploads.get(book_id)
        upload_ok = not args.auto_upload or (upload_info and (upload_info.get("status") == "complete" or upload_info.get("percent") == 100))
        
        if (info.get("status") == "complete" or info.get("percent") == 100) and upload_ok:
            # find original folder in processing
            for pb in processing_books:
                # Naive match
                if info["title"].replace(" ", "_") in pb.name or pb.name in info["title"]:
                    dest = COMPLETED_DIR / pb.name
                    if pb.exists():
                        shutil.move(str(pb), str(dest))
                        console.print(f"Moved [green]{pb.name}[/green] to in-hugging-face")

if __name__ == "__main__":
    main()
