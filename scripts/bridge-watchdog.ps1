# 看門狗：bridge（3100 控制台埠）沒在聽就把它拉起來。
# 由兩個計畫任務呼叫：登入時一次、每 5 分鐘一次。
# 只做「沒跑就啟動」，不改任何設定；跑著的時候它什麼都不做。
$ErrorActionPreference = 'SilentlyContinue'

$root = 'C:\Users\USER\Documents\deepseek-harness\default-workspace\surfcore'
$port = 3100
$node = 'D:/deepseek/resources/runtime/primary-runtime/dependencies/node/bin/node.exe'
$log = Join-Path $root 'state\watchdog.log'

function Write-WatchLog([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding UTF8
}

# 1) 埠在聽 = 活著，直接退出（最省事、也最準）
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

# 2) 埠沒在聽：可能剛崩、也可能上一次啟動還在 boot，先給 5 秒冷卻
$lock = Join-Path $root 'state\bridge.lock'
if (Test-Path $lock) {
  $stamp = (Get-Item $lock).LastWriteTime
  if (((Get-Date) - $stamp).TotalSeconds -lt 5) { exit 0 }
}

# 3) 清掉可能殘留的鎖（進程已經不在了，鎖留著只會讓新進程 exit 2）
if (Test-Path $lock) {
  $pidText = (Get-Content $lock -Raw).Trim()
  $alive = $false
  if ($pidText -match '^\d+$') {
    $alive = [bool](Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue)
  }
  if (-not $alive) {
    Remove-Item $lock -Force
    Write-WatchLog "清掉殘留的 bridge.lock（$pidText 已經不在了）"
  } else {
    exit 0
  }
}

# 4) 起 bridge（隱藏視窗、detached）。bridge 自己會寫 state/bridge.log
$p = Start-Process -FilePath $node -ArgumentList 'src/bridge.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 4
if ($p -and -not $p.HasExited) {
  Set-Content -Path (Join-Path $root 'state\bridge.pid') -Value $p.Id -Encoding ASCII
  Write-WatchLog "bridge 沒在跑，已拉起 PID $($p.Id)"
} else {
  Write-WatchLog '嘗試拉起 bridge，但進程 4 秒內就退出了（請看 state/bridge.log）'
}
