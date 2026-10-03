# MV-Director - Khởi động nhanh (PowerShell)
# Chạy: chuột phải > Run with PowerShell, hoặc:  powershell -ExecutionPolicy Bypass -File Start-MV-Director.ps1
$ErrorActionPreference = 'SilentlyContinue'
$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appRoot

Write-Host '=== MV-Director - Khởi động nhanh ===' -ForegroundColor Cyan

# Cần Node.js
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host '[LỖI] Chưa cài Node.js (>=22). Tải tại https://nodejs.org rồi chạy lại.' -ForegroundColor Red
  Read-Host 'Nhấn Enter để thoát'; exit 1
}

# 1) Tắt server cũ đang chiếm cổng 7788
Write-Host '[1/3] Đóng server cũ trên cổng 7788 (nếu có)...'
Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

# 2) Cập nhật code mới nhất (bỏ qua nếu không có git/mạng)
Write-Host '[2/3] Cập nhật code (git pull)...'
git pull 2>$null | Out-Null

# 3) Mở trình duyệt sau 2 giây và chạy server trong cửa sổ này
Write-Host '[3/3] Mở http://localhost:7788 và chạy server...'
Write-Host '    Để DỪNG server: đóng cửa sổ này hoặc nhấn Ctrl+C.' -ForegroundColor Yellow
Start-Job { Start-Sleep 2; Start-Process 'http://localhost:7788' } | Out-Null
& $node 'server.mjs'
