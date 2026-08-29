param(
    [int]$RefreshSeconds = 3
)

$ErrorActionPreference = "SilentlyContinue"
$projectRoot = "C:\Personal_Endeavours\BookSync2"
$libraryRoot = "C:\Users\Mushfiq\Downloads\BookSync"
$snapshotPath = Join-Path $projectRoot "local-data\books\_operations\legacy-newnewnew\processed\live-dashboard.txt"
$eventLogPath = Join-Path $projectRoot "local-data\books\_operations\legacy-newnewnew\processed\unified-events.log"
$uploadStatusPath = Join-Path $projectRoot "local-data\books\_operations\legacy-newnewnew\processed\upload-status.json"
$logicalProcessors = [Math]::Max(1, [Environment]::ProcessorCount)

$books = @(
    @{ Title = "The Innovator's Dilemma"; Folder = Join-Path $libraryRoot "The_Innovator_s_Dilemma" },
    @{ Title = "One Hundred Years of Solitude"; Folder = Join-Path $libraryRoot "One_Hundred_Years_of_Solitude" },
    @{ Title = "Thinking, Fast and Slow"; Folder = Join-Path $libraryRoot "Thinking_Fast_and_Slow" },
    @{ Title = "All the Light We Cannot See"; Folder = Join-Path $libraryRoot "All_the_Light_We_Cannot_See" },
    @{ Title = "Sapiens"; Folder = Join-Path $libraryRoot "Sapiens" },
    @{ Title = "The Pragmatic Programmer"; Folder = Join-Path $libraryRoot "The_Pragmatic_Programmer" },
    @{ Title = "The Book Thief"; Folder = Join-Path $libraryRoot "The_Book_Thief" },
    @{ Title = "The Death of Ivan Ilyich"; Folder = Join-Path $libraryRoot "The_Death_of_Ivan_Ilyich"; UploadAuthorized = $false },
    @{ Title = "Man's Search for Meaning"; Folder = Join-Path $libraryRoot "Man_s_Search_for_Meaning"; UploadAuthorized = $false },
    @{ Title = "A Spy Among Friends"; Folder = Join-Path $libraryRoot "A_Spy_Among_Friends"; UploadAuthorized = $false }
)

$previousCpu = @{}
$previousSample = Get-Date
$previousStates = @{}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch { return $null }
}

function Get-LatestBookEvent([string]$folder) {
    $progress = Read-JsonFile (Join-Path $folder "processing-progress.json")
    if ($progress -and $progress.status -eq "complete") {
        return [ordered]@{ stage = "packaged"; percent = 100; message = "Package complete" }
    }

    $logPath = Join-Path $folder "processor.stdout.log"
    if (-not (Test-Path -LiteralPath $logPath)) {
        return [ordered]@{ stage = "queued"; percent = 0; message = "Waiting for GPU slot" }
    }

    $line = Get-Content -LiteralPath $logPath -Tail 250 | Where-Object { $_ -match '^BOOKSYNC_EVENT ' } | Select-Object -Last 1
    if (-not $line) {
        return [ordered]@{ stage = "starting"; percent = 0; message = "Processor starting" }
    }
    try {
        $event = $line.Substring("BOOKSYNC_EVENT ".Length) | ConvertFrom-Json
        return [ordered]@{ stage = [string]$event.stage; percent = [double]$event.percent; message = [string]$event.message }
    } catch {
        return [ordered]@{ stage = "working"; percent = 0; message = "Reading processor output" }
    }
}

function Get-WorkerMap {
    $map = @{}
    foreach ($statusPath in @(
        (Join-Path $projectRoot "local-data\books\_operations\legacy-newnew\processed\queue-status.json"),
        (Join-Path $projectRoot "local-data\books\_operations\legacy-newnewnew\processed\queue-status.json"),
        (Join-Path $projectRoot "local-data\books\_operations\legacy-newnewnew\processed\queue-status-next-three.json")
    )) {
        $status = Read-JsonFile $statusPath
        foreach ($entry in @($status.active_processes)) {
            if ($entry.title -and $entry.pid) { $map[[string]$entry.title] = [int]$entry.pid }
        }
    }
    return $map
}

function Get-GpuSummary {
    try {
        $line = & nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null | Select-Object -First 1
        if (-not $line) { return "GPU metrics unavailable" }
        $values = $line -split ',' | ForEach-Object { $_.Trim() }
        return "GPU $($values[0])% | VRAM $($values[1])/$($values[2]) MiB | $($values[3]) C | $($values[4]) W"
    } catch { return "GPU metrics unavailable" }
}

function Get-SystemCpu {
    try {
        $sample = Get-Counter '\Processor(_Total)\% Processor Time' -MaxSamples 1
        return [Math]::Round($sample.CounterSamples[0].CookedValue)
    } catch { return $null }
}

while ($true) {
    $now = Get-Date
    $elapsed = [Math]::Max(0.1, ($now - $previousSample).TotalSeconds)
    $workerMap = Get-WorkerMap
    $upload = Read-JsonFile $uploadStatusPath
    $uploadedTitles = @($upload.uploaded)
    $failedUploads = @($upload.failed)
    $rows = @()
    $currentCpu = @{}

    foreach ($book in $books) {
        $event = Get-LatestBookEvent $book.Folder
        $workerPid = $workerMap[$book.Title]
        $workerCpu = $null
        if ($workerPid) {
            $process = Get-Process -Id $workerPid
            if ($process) {
                $cpuSeconds = $process.TotalProcessorTime.TotalSeconds
                $currentCpu[$workerPid] = $cpuSeconds
                if ($previousCpu.ContainsKey($workerPid)) {
                    $workerCpu = [Math]::Round((($cpuSeconds - $previousCpu[$workerPid]) / $elapsed) * 100 / $logicalProcessors)
                }
            }
        }

        $uploadState = if ($book.ContainsKey("UploadAuthorized") -and -not $book.UploadAuthorized) {
            "not queued"
        } elseif ($uploadedTitles -contains $book.Title) {
            "uploaded"
        } elseif ($upload.title -eq $book.Title -and $upload.status -eq "uploading") {
            "uploading"
        } elseif ($failedUploads -match [regex]::Escape($book.Title)) {
            "failed"
        } elseif ($event.stage -eq "packaged") {
            "ready"
        } else {
            "waiting"
        }

        $rows += [ordered]@{
            title = $book.Title
            stage = $event.stage
            percent = $event.percent
            message = $event.message
            pid = $workerPid
            cpu = $workerCpu
            upload = $uploadState
        }
    }

    $previousCpu = $currentCpu
    $previousSample = $now
    $gpuBook = $rows | Where-Object { $_.stage -eq "transcribing" -and $_.pid } | Select-Object -First 1
    $cpuBooks = @($rows | Where-Object { $_.stage -in "aligning", "rendering", "packaging" -and $_.pid })
    $systemCpu = Get-SystemCpu

    $output = [System.Collections.Generic.List[string]]::new()
    $output.Add("BOOKSYNC LIVE PIPELINE   $($now.ToString('yyyy-MM-dd HH:mm:ss'))")
    $output.Add((Get-GpuSummary))
    $output.Add("GPU BOOK: $(if ($gpuBook) { $gpuBook.title + ' - ' + $gpuBook.message } else { 'No active transcription' })")
    $output.Add("CPU: $(if ($null -ne $systemCpu) { "$systemCpu% system" } else { 'metrics unavailable' }) | DOWNSTREAM BOOKS: $(if ($cpuBooks.Count) { ($cpuBooks.title -join ', ') } else { 'none' })")
    $transferText = if ($upload.transfer) { "$($upload.transfer.state.ToUpperInvariant()) | $($upload.transfer.book) | $($upload.transfer.summary)" } else { "No active transfer" }
    $authorizedCount = @($books | Where-Object { -not $_.ContainsKey("UploadAuthorized") -or $_.UploadAuthorized }).Count
    $output.Add("UPLOAD: $($upload.status) | $($uploadedTitles.Count)/$authorizedCount authorized verified | $($upload.repository)")
    $output.Add("TRANSFER: $transferText")
    $output.Add("")
    $output.Add(("{0,-35} {1,-14} {2,8} {3,7} {4,-10}  {5}" -f "BOOK", "STAGE", "PROGRESS", "CPU", "UPLOAD", "CURRENT WORK"))
    $output.Add(("-" * 138))

    foreach ($row in $rows) {
        $title = if ($row.title.Length -gt 34) { $row.title.Substring(0, 31) + "..." } else { $row.title }
        $message = if ($row.message.Length -gt 55) { $row.message.Substring(0, 52) + "..." } else { $row.message }
        $cpuText = if ($null -eq $row.cpu) { "-" } else { "$($row.cpu)%" }
        $output.Add(("{0,-35} {1,-14} {2,7:N1}% {3,7} {4,-10}  {5}" -f $title, $row.stage, $row.percent, $cpuText, $row.upload, $message))

        $signature = "$($row.stage)|$($row.percent)|$($row.upload)|$($row.message)"
        if ($previousStates[$row.title] -ne $signature) {
            Add-Content -LiteralPath $eventLogPath -Encoding utf8 -Value "[$($now.ToString('yyyy-MM-dd HH:mm:ss'))] $($row.title) | $($row.stage) $($row.percent)% | upload=$($row.upload) | $($row.message)"
            $previousStates[$row.title] = $signature
        }
    }

    $output.Add("")
    $output.Add("Live snapshot: $snapshotPath")
    $output.Add("State changes: $eventLogPath")
    $output | Set-Content -LiteralPath $snapshotPath -Encoding utf8

    [Console]::Write("`e[2J`e[H")
    [Console]::WriteLine(($output -join [Environment]::NewLine))
    Start-Sleep -Seconds $RefreshSeconds
}
