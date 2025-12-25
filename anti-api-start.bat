@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   █████╗ ███╗   ██╗████████╗██╗         █████╗ ██████╗ ██╗
echo  ██╔══██╗████╗  ██║╚══██╔══╝██║        ██╔══██╗██╔══██╗██║
echo  ███████║██╔██╗ ██║   ██║   ██║ █████╗ ███████║██████╔╝██║
echo  ██╔══██║██║╚██╗██║   ██║   ██║ ╚════╝ ██╔══██║██╔═══╝ ██║
echo  ██║  ██║██║ ╚████║   ██║   ██║        ██║  ██║██║     ██║
echo  ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝        ╚═╝  ╚═╝╚═╝     ╚═╝
echo.
echo ================================
echo.

set PORT=8964

:: 检查端口占用
netstat -ano | findstr :%PORT% >nul 2>&1
if %errorlevel%==0 (
    echo 端口: %PORT%
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%PORT%') do taskkill /PID %%a /F >nul 2>&1
    echo 端口被占用但已释放.
) else (
    echo 端口: %PORT%
)

:: 检查 bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo 安装 Bun...
    powershell -Command "irm bun.sh/install.ps1 | iex"
)

:: 安装依赖
if not exist "node_modules" (
    bun install --silent
)

echo anti-api已启动.
echo.
echo ================================
echo.
echo 配额面板:
echo http://localhost:%PORT%/quota
echo.
echo ================================
echo.

bun run src/main.ts start
pause
