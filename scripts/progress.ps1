param(
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][string]$Command,
  [int]$TimeoutSec = 300,
  [string]$WorkDir = (Split-Path -Parent $PSScriptRoot)
)

# Progress bar + elapsed + timeout countdown; aborts and reports the blocking point on timeout.
# 关键约束：任何读取都必须有上限。子进程被杀后其孙进程可能仍持有管道，
# 同步等待 ReadToEnd 的结果会永久阻塞，因此统一用 Task.Wait(ms) 兜底，超时分支必定退出。

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = 'cmd.exe'
$psi.Arguments = "/d /c $Command"
$psi.WorkingDirectory = $WorkDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

function Get-TaskText {
  param($Task, [int]$TimeoutMs = 1500)
  if ($null -eq $Task) { return '' }
  try {
    if ($Task.Wait($TimeoutMs)) { return $Task.Result }
  } catch {
    return ''
  }
  return ''
}

function Write-Lines {
  param([string]$Text, [switch]$AsError)
  if (-not $Text) { return }
  foreach ($line in ($Text.TrimEnd() -split "`r?`n")) {
    if ($AsError) { Write-Host $line -ForegroundColor DarkGray } else { Write-Host $line }
  }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = [System.Diagnostics.Process]::Start($psi)
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

$frames = '|', '/', '-', '\'
$i = 0
while (-not $proc.HasExited) {
  $elapsed = [int]$sw.Elapsed.TotalSeconds
  $left = $TimeoutSec - $elapsed
  if ($left -le 0) { break }
  $pct = [math]::Min(99, [int]($elapsed / $TimeoutSec * 100))
  Write-Progress -Activity $Label -Status ("{0} elapsed {1}s / limit {2}s (left {3}s)" -f $frames[$i % 4], $elapsed, $TimeoutSec, $left) -PercentComplete $pct
  Start-Sleep -Milliseconds 300
  $i++
  if ($proc.HasExited) { break }
}

if (-not $proc.HasExited) {
  # cmd.exe 不会把 Kill 传递给孙进程（node/postgres/ping 都会残留），先用 taskkill /T 结束整棵树
  try { & taskkill.exe /F /T /PID $proc.Id 2>$null | Out-Null } catch {}
  try { if (-not $proc.HasExited) { $proc.Kill($true) } } catch {}
  try { [void]$proc.WaitForExit(2000) } catch {}
  Write-Progress -Activity $Label -Completed
  Write-Host "[TIMEOUT] $Label exceeded ${TimeoutSec}s and was aborted." -ForegroundColor Red
  Write-Host "---- partial output ----" -ForegroundColor Yellow
  Write-Lines (Get-TaskText $outTask 1000)
  Write-Lines (Get-TaskText $errTask 500) -AsError
  Write-Host ("[FAIL] {0} aborted after {1:N1}s, exit=124" -f $Label, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
  exit 124
}

try { [void]$proc.WaitForExit(5000) } catch {}
$code = $proc.ExitCode
Write-Progress -Activity $Label -Completed

Write-Lines (Get-TaskText $outTask 5000)
Write-Lines (Get-TaskText $errTask 2000) -AsError

$tag = if ($code -eq 0) { 'OK' } else { 'FAIL' }
$color = if ($code -eq 0) { 'Green' } else { 'Red' }
Write-Host ("[{0}] {1} done in {2:N1}s, exit={3}" -f $tag, $Label, $sw.Elapsed.TotalSeconds, $code) -ForegroundColor $color
exit $code
