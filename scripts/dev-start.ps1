param(
  # -NoBrowser：只起服务，不自动打开浏览器（用于自动化 / 后台场景）
  [switch]$NoBrowser
)

# 一键启动开发环境：MySQL 服务 → 后端 :3000 → 前端 :5173
# 仓库位置：<repo>/scripts/dev-start.ps1，前端默认是同级目录下的 frontend-starter
$ErrorActionPreference = 'Continue'

$backend = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path (Split-Path -Parent $backend) 'frontend-starter'
$node = 'C:\Program Files\nodejs\node.exe'
$env:Path = 'C:\Program Files\nodejs;' + $env:Path

function Test-Port([int]$port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Wait-Port([int]$port, [int]$timeoutSeconds = 25) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSeconds) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

Write-Host ''
Write-Host '  开发环境一键启动' -ForegroundColor Cyan
Write-Host '  ----------------------------'
Write-Host "  后端: $backend"
Write-Host "  前端: $frontend"

# 1. MySQL 服务
$svc = Get-Service -Name 'MySQL84' -ErrorAction SilentlyContinue
if ($null -eq $svc) {
  Write-Host '[!] 没找到 MySQL84 服务，跳过（若用容器版请先 docker compose up -d）' -ForegroundColor Yellow
} elseif ($svc.Status -ne 'Running') {
  Write-Host '[*] 正在启动 MySQL84 ...'
  try {
    Start-Service -Name 'MySQL84' -ErrorAction Stop
    Write-Host '[+] MySQL84 已启动' -ForegroundColor Green
  } catch {
    Write-Host "[!] MySQL84 启动失败：$($_.Exception.Message)" -ForegroundColor Red
  }
} else {
  Write-Host '[=] MySQL84 已在运行' -ForegroundColor DarkGray
}

# 2. 后端
if (Test-Port 3000) {
  Write-Host '[=] 后端已在 :3000 运行' -ForegroundColor DarkGray
} else {
  Write-Host '[*] 正在启动后端 ...'
  $null = New-Item -ItemType Directory -Path "$backend\logs" -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $node -ArgumentList 'src/index.js' -WorkingDirectory $backend `
    -RedirectStandardOutput "$backend\logs\backend.out.log" `
    -RedirectStandardError "$backend\logs\backend.err.log" -WindowStyle Hidden
  if (Wait-Port 3000) { Write-Host '[+] 后端已就绪 http://localhost:3000' -ForegroundColor Green }
  else { Write-Host '[!] 后端 25 秒内没起来，看 logs\backend.err.log' -ForegroundColor Red }
}

# 3. 前端
if (Test-Port 5173) {
  Write-Host '[=] 前端已在 :5173 运行' -ForegroundColor DarkGray
} else {
  Write-Host '[*] 正在启动前端 ...'
  $null = New-Item -ItemType Directory -Path "$frontend\logs" -Force -ErrorAction SilentlyContinue
  # 直接调 vite 的 CLI，经 npm.cmd 起会多一层 cmd 进程、还容易把终端句柄挂住
  Start-Process -FilePath $node -ArgumentList 'node_modules\vite\bin\vite.js' -WorkingDirectory $frontend `
    -RedirectStandardOutput "$frontend\logs\vite.out.log" `
    -RedirectStandardError "$frontend\logs\vite.err.log" -WindowStyle Hidden
  if (Wait-Port 5173) { Write-Host '[+] 前端已就绪 http://localhost:5173' -ForegroundColor Green }
  else { Write-Host '[!] 前端 25 秒内没起来，看 logs\vite.err.log' -ForegroundColor Red }
}

# 4. 汇总 + 打开浏览器
Write-Host '  ----------------------------'
$apiOk = $false
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3000/api/hello' -TimeoutSec 5 -UseBasicParsing
  $apiOk = $r.StatusCode -eq 200
} catch { $apiOk = $false }

Write-Host ("  后端接口: " + $(if ($apiOk) { '正常' } else { '异常' })) -ForegroundColor $(if ($apiOk) { 'Green' } else { 'Red' })
Write-Host ("  前端页面: " + $(if (Test-Port 5173) { 'http://localhost:5173' } else { '未启动' }))
Write-Host ''

if ($apiOk -and -not $NoBrowser) {
  # 交给 cmd 的 start 打开默认浏览器，cmd 立刻退出，不会把终端输出句柄挂住
  try {
    $log = Join-Path $env:TEMP 'dev-start-browser.log'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start', '', 'http://localhost:5173' `
      -RedirectStandardOutput $log -RedirectStandardError $log -WindowStyle Hidden
  } catch {
    Write-Host '[!] 自动打开浏览器失败，手动访问 http://localhost:5173' -ForegroundColor Yellow
  }
}
Write-Host '窗口可以关掉，服务在后台继续跑。' -ForegroundColor DarkGray
Start-Sleep -Seconds 3
