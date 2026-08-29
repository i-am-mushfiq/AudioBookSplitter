param(
    [ValidateSet("run", "stop", "status", "scan", "canary", "reconcile")]
    [string]$Command = "run",
    [string]$Queue = "C:\Personal_Endeavours\BookSync2\local-data\books\upload_ready",
    [string]$Destination = "C:\Users\Mushfiq\Downloads\BookSync",
    [string]$Log = "C:\Personal_Endeavours\BookSync2\local-data\books\upload_ready\live.txt",
    [int]$CanaryMB = 16,
    [string]$Only = ""
)

$ErrorActionPreference = "Stop"
$project = "C:\Personal_Endeavours\BookSync2"
$supervisor = Join-Path $project "tools\booksync_upload_supervisor.py"
$arguments = @(
    "run", "--no-capture-output", "-n", "animal-farm-splitter",
    "python", $supervisor, $Command,
    "--queue", $Queue,
    "--destination", $Destination,
    "--log", $Log,
    "--canary-mb", $CanaryMB
)
if ($Only) { $arguments += @("--only", $Only) }

& conda @arguments
exit $LASTEXITCODE
