/** Bounded CLR ETW capture. Embedded at build time, no external skill or dependency. */
export const captureClrExceptions = String.raw`[CmdletBinding(DefaultParameterSetName = 'Capture')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Capture')]
    [ValidateRange(1, 2147483647)][int]$TargetProcessId,
    [Parameter(ParameterSetName = 'Capture')]
    [ValidateRange(10, 120)][int]$DurationSeconds = 90,
    [string]$TraceKey = ([Guid]::NewGuid().ToString('N')),
    [string]$ExpectedStartUtc = '',
    [Parameter(Mandatory = $true, ParameterSetName = 'SelfTest')][switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
if ($SelfTest) { $TargetProcessId = $PID }
$captureDuration = if ($SelfTest) { 2 } else { $DurationSeconds }
$target = Get-Process -Id $TargetProcessId
$targetStart = $target.StartTime.ToUniversalTime()
if ($TraceKey -notmatch '^[0-9a-f]{32}$') { throw 'Invalid trace key' }
if ($ExpectedStartUtc -and $targetStart -ne [DateTime]::Parse($ExpectedStartUtc).ToUniversalTime()) { throw 'Target process identity changed' }
$session = 'COS-LiveDebug-' + $TraceKey
$folder = Join-Path ([IO.Path]::GetTempPath()) $session
$etl = Join-Path $folder 'exceptions.etl'
$stopFile = Join-Path $folder 'stop.signal'
$activeFile = Join-Path $folder 'active.signal'
$started = $false
$stopped = $false
$captured = New-Object 'System.Collections.Generic.List[object]'
$matching = 0
$reason = 'deadline'
[void][IO.Directory]::CreateDirectory($folder)

function Stop-Trace {
    $output = & logman.exe stop $session -ets 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('ETW stop failed: ' + ($output -join ' ')) }
}

try {
    $output = & logman.exe start $session -ets -p '{e13c0d23-ccbc-4e12-931b-d9cc2eee27e4}' 0x8000 5 -o $etl -f bincirc -max 16 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('ETW start failed: ' + ($output -join ' ')) }
    $started = $true
    $captureStart = [DateTime]::UtcNow
    $deadline = $captureStart.AddSeconds($captureDuration)
    [IO.File]::WriteAllText($activeFile, '')
    'TRACE_READY ' + ([ordered]@{ session = $session; pid = $TargetProcessId; process = $target.ProcessName; window = $target.MainWindowTitle; processStartUtc = $targetStart.ToString('o'); captureStartUtc = $captureStart.ToString('o'); deadlineUtc = $deadline.ToString('o'); stopFile = $stopFile } | ConvertTo-Json -Compress)

    if ($SelfTest) { try { [void][int]::Parse('COS_LIVE_DEBUG_PROBE') } catch {} }
    while ([DateTime]::UtcNow -lt $deadline) {
        if ([IO.File]::Exists($stopFile)) { $reason = 'user-stop'; break }
        $live = Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue
        if (-not $live -or $live.StartTime.ToUniversalTime() -ne $targetStart) { $reason = 'target-exited'; break }
        Start-Sleep -Milliseconds 250
    }
    $captureEnd = [DateTime]::UtcNow
    [IO.File]::Delete($activeFile)
    Stop-Trace
    $stopped = $true

    Get-WinEvent -Path $etl -Oldest | ForEach-Object {
        if ($_.Id -eq 80 -and $_.ProcessId -eq $TargetProcessId -and $_.ProviderId -eq [Guid]'e13c0d23-ccbc-4e12-931b-d9cc2eee27e4' -and $_.TimeCreated.ToUniversalTime() -ge $captureStart -and $_.TimeCreated.ToUniversalTime() -le $captureEnd) {
            $matching++
            if ($captured.Count -lt 30) {
                $message = [string]$_.Properties[1].Value
                if ($message.Length -gt 500) { $message = $message.Substring(0, 500) + ' [truncated]' }
                $captured.Add([ordered]@{ timeUtc = $_.TimeCreated.ToUniversalTime().ToString('o'); pid = $_.ProcessId; threadId = $_.ThreadId; type = [string]$_.Properties[0].Value; message = $message })
            }
        }
    }
    'TRACE_RESULT ' + ([ordered]@{ session = $session; pid = $TargetProcessId; reason = $reason; captureStartUtc = $captureStart.ToString('o'); captureEndUtc = $captureEnd.ToString('o'); matchingEvents = $matching; circularBufferMB = 16; truncated = ($matching -gt $captured.Count); events = @($captured.ToArray()) } | ConvertTo-Json -Depth 5 -Compress)
    if ($SelfTest -and -not ($captured | Where-Object { $_.type -eq 'System.FormatException' })) { throw 'Self-test failed: expected FormatException not captured' }
} finally {
    [IO.File]::Delete($activeFile)
    if ($started -and -not $stopped) {
        try { Stop-Trace; $stopped = $true } catch { Write-Warning $_.Exception.Message }
    }
    if (-not $started -or $stopped) {
        Remove-Item -LiteralPath $folder -Recurse -Force
    } else {
        Write-Warning ('Trace cleanup incomplete: ' + $session + ' at ' + $folder)
    }
}
`;
