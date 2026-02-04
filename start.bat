@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set UPDATE_MODE=0
set UPDATE_ONLY=0
:parse_args
if "%~1"=="" goto after_args
if /I "%~1"=="--update" set UPDATE_MODE=1
if /I "%~1"=="-u" set UPDATE_MODE=1
if /I "%~1"=="--update-only" (
    set UPDATE_MODE=1
    set UPDATE_ONLY=1
)
shift
goto parse_args
:after_args

if %UPDATE_MODE%==1 call :do_update
if %UPDATE_MODE%==1 if %UPDATE_ONLY%==1 goto :end

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

:do_update
set "API_URL=https://api.github.com/repos/ink1ing/anti-api/releases/latest"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$r=Invoke-RestMethod -Uri '%API_URL%';" ^
    "$asset=$r.assets | Where-Object { $_.name -match '^anti-api-v.*\\.zip$' } | Select-Object -First 1;" ^
    "if(-not $asset){ exit 2 };" ^
    "$url=$asset.browser_download_url;" ^
    "$tmp=Join-Path $env:TEMP 'anti-api-update';" ^
    "Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue;" ^
    "New-Item -ItemType Directory -Path $tmp | Out-Null;" ^
    "$zip=Join-Path $tmp 'release.zip';" ^
    "Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing;" ^
    "Expand-Archive -Path $zip -DestinationPath $tmp -Force;" ^
    "$dir=Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'anti-api-v*' } | Select-Object -First 1;" ^
    "if(-not $dir){ exit 3 };" ^
    "$src=$dir.FullName; $dst=(Get-Location).Path;" ^
    "robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /XD data node_modules .git /XF .env >$null;" ^
    "if(Test-Path (Join-Path $src 'anti-api-start.command')){ Copy-Item (Join-Path $src 'anti-api-start.command') (Join-Path $dst 'start.command') -Force };" ^
    "if(Test-Path (Join-Path $src 'anti-api-start.bat')){ Copy-Item (Join-Path $src 'anti-api-start.bat') (Join-Path $dst 'start.bat') -Force }"
if %errorlevel% geq 8 (
    echo [错误] 自动更新失败
    exit /b 1
)
echo 已更新到最新版本
exit /b 0

:error
echo.
echo 按任意键退出...
pause >nul
exit /b 1

:end
exit /b 0
