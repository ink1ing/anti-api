@echo off
chcp 65001 >nul
title Anti-API

echo ================================
echo     Anti-API Starting...
echo ================================
echo.

REM Check if Antigravity is running
tasklist /FI "IMAGENAME eq Antigravity.exe" 2>NUL | find /I /N "Antigravity.exe">NUL
if "%ERRORLEVEL%"=="1" (
    echo [WARNING] Antigravity is not running
    echo Please start Antigravity and login first
    echo.
    pause
)

REM Check if bun is installed, if not, install it
where bun >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [INFO] Bun not found, installing...
    echo.
    powershell -c "irm bun.sh/install.ps1 | iex"
    
    REM Refresh PATH
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
    
    REM Verify installation
    where bun >nul 2>nul
    if %ERRORLEVEL% neq 0 (
        echo.
        echo [ERROR] Bun installation failed
        echo Please install manually: https://bun.sh
        echo.
        pause
        exit /b 1
    )
    
    echo.
    echo [SUCCESS] Bun installed!
    echo.
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call bun install
    echo.
)

echo Starting Anti-API server...
echo.
echo ================================
echo   Port: 8964
echo   Dashboard: http://localhost:8964
echo ================================
echo.
echo Press Ctrl+C to stop
echo.

bun run src/main.ts start
