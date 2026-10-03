@echo off
chcp 65001 >nul
title MV-Director
cd /d "%~dp0"

echo ============================================
echo    MV-Director - Khoi dong nhanh
echo ============================================
echo.

REM --- Kiem tra Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [LOI] Chua cai Node.js. Tai ban >=22 tai https://nodejs.org roi chay lai file nay.
  echo.
  pause
  exit /b 1
)

REM --- 1) Tat server cu dang chiem cong 7788 ---
echo [1/3] Dong server cu tren cong 7788 (neu co)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :7788 ^| findstr LISTENING') do (
  taskkill /PID %%p /F >nul 2>&1
)

REM --- 2) Cap nhat code moi nhat (bo qua neu khong co git / khong co mang) ---
echo [2/3] Cap nhat code (git pull)...
git pull 2>nul
if errorlevel 1 echo    (Bo qua cap nhat - van chay ban hien tai, khong sao)

REM --- 3) Mo trinh duyet sau 2 giay va chay server ---
echo [3/3] Mo http://localhost:7788 va chay server...
echo.
echo    De DUNG server: dong cua so nay hoac bam Ctrl+C.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:7788"
node server.mjs

echo.
echo Server da dung.
pause
