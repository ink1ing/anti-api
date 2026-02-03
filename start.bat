@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   █████╗ ███╗   ██╗████████╗██╗         █████╗ ██████╗ ██╗
echo  ██╔══██╗████╗  ██║╚══██╔══╝██║        ██╔══██╗██╔══██╗██║
echo  ███████║██╔██╗ ██║   ██║   ██║ █████╗ ███████║██████╔╝██║
echo  ██╔══██║██║╚██╗██║   ██║   ██║ ╚════╝ ██╔══██║██╔═══╝ ██║
echo  ██║  ██║██║ ╚████║   ██║   ██║        ██║  ██║██║     ██║
echo  ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝        ╚═╝  ╚═╝╚═╝     ╚═╝
echo.

set PORT=8964
set RUST_PROXY_PORT=8965

:: 静默释放端口
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%PORT% 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%RUST_PROXY_PORT% 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
:: 等待端口释放
timeout /t 1 /nobreak >nul 2>&1

:: 加载 bun 路径（如果已安装）
if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

:: 确保 ngrok 可用（若未安装则自动下载）
where ngrok >nul 2>&1
if %errorlevel% neq 0 (
    set "NGROK_DIR=%USERPROFILE%\.local\bin"
    if not exist "%NGROK_DIR%" mkdir "%NGROK_DIR%" >nul 2>&1
    set "ARCH=%PROCESSOR_ARCHITECTURE%"
    set "NGROK_URL=https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-stable-windows-amd64.zip"
    if /I "%ARCH%"=="ARM64" set "NGROK_URL=https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-stable-windows-arm64.zip"
    powershell -ExecutionPolicy Bypass -Command ^
        "$p='%NGROK_DIR%';" ^
        "$u='%NGROK_URL%';" ^
        "$z=Join-Path $env:TEMP 'ngrok.zip';" ^
        "try { Invoke-WebRequest -Uri $u -OutFile $z -UseBasicParsing; Expand-Archive -Path $z -DestinationPath $p -Force } catch {}"
    set "PATH=%NGROK_DIR%;%PATH%"
)

:: 检查 bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo 安装 Bun...
    echo (如果安装失败，请以管理员身份运行)
    powershell -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    if %errorlevel% neq 0 (
        echo [错误] Bun 安装失败，请以管理员身份运行或手动安装
        goto :error
    )
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

:: 再次检查 bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 找不到 Bun，请手动安装: https://bun.sh
    goto :error
)

:: 安装依赖（静默）
if not exist "node_modules" (
    echo 正在安装依赖...
    bun install --silent
)

:: 启动 Rust Proxy（后台运行）
set RUST_PROXY_BIN=rust-proxy\target\release\anti-proxy.exe
if not exist "%RUST_PROXY_BIN%" (
    where cargo >nul 2>&1
    if %errorlevel% equ 0 (
        cargo build --release --manifest-path rust-proxy\Cargo.toml >nul 2>&1
    )
)
if exist "%RUST_PROXY_BIN%" (
    start "" /B cmd /c "%RUST_PROXY_BIN%" >nul 2>&1
    timeout /t 1 /nobreak >nul 2>&1
)

:: 启动 TypeScript 服务器
bun run src/main.ts start

:: 清理 Rust Proxy
taskkill /IM anti-proxy.exe /F >nul 2>&1

goto :end

:error
echo.
echo 按任意键退出...
pause >nul
exit /b 1

:end
exit /b 0
