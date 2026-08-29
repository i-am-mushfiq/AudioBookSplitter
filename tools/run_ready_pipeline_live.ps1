param(
    [ValidateSet('run','resume','pause','status','scan')]
    [string]$Command = 'run',
    [string]$Source = 'D:\Audiobooks\__Ready',
    [string]$Processed = 'D:\Audiobooks\__Processed',
    [string]$InHuggingFace = 'D:\Audiobooks\__in_hugging_face',
    [string]$Output = 'C:\Personal_Endeavours\BookSync2\local-data\books\raw_processing',
    [string]$UploadReady = 'C:\Personal_Endeavours\BookSync2\local-data\books\upload_ready',
    [string]$Destination = 'C:\Users\Mushfiq\Downloads\BookSync'
)

$ErrorActionPreference = 'Stop'
$supervisor = Join-Path $PSScriptRoot 'booksync_pipeline_supervisor.py'
$arguments = @(
    'run', '--no-capture-output', '-n', 'animal-farm-splitter',
    'python', $supervisor, $Command,
    '--source', $Source,
    '--processed', $Processed,
    '--in-hugging-face', $InHuggingFace,
    '--output', $Output,
    '--upload-ready', $UploadReady,
    '--destination', $Destination,
    '--auto-upload'
)

& conda @arguments
exit $LASTEXITCODE
