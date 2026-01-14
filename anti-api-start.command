#!/bin/bash
cd "$(dirname "$0")"

# 颜色定义 #C15F3C
ORANGE='\033[38;2;193;95;60m'
NC='\033[0m'

echo ""
echo -e "${ORANGE}  █████╗ ███╗   ██╗████████╗██╗         █████╗ ██████╗ ██╗${NC}"
echo -e "${ORANGE} ██╔══██╗████╗  ██║╚══██╔══╝██║        ██╔══██╗██╔══██╗██║${NC}"
echo -e "${ORANGE} ███████║██╔██╗ ██║   ██║   ██║ █████╗ ███████║██████╔╝██║${NC}"
echo -e "${ORANGE} ██╔══██║██║╚██╗██║   ██║   ██║ ╚════╝ ██╔══██║██╔═══╝ ██║${NC}"
echo -e "${ORANGE} ██║  ██║██║ ╚████║   ██║   ██║        ██║  ██║██║     ██║${NC}"
echo -e "${ORANGE} ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝        ╚═╝  ╚═╝╚═╝     ╚═╝${NC}"
echo ""
echo "================================"
echo ""

PORT=8964
RUST_PROXY_PORT=8965

echo "端口: $PORT"
echo "Rust Proxy 端口: $RUST_PROXY_PORT"

# 检查端口占用
if lsof -i :$PORT > /dev/null 2>&1; then
    echo "端口被占用."
    lsof -ti :$PORT | xargs kill -9 2>/dev/null
    echo "端口已释放."
fi

if lsof -i :$RUST_PROXY_PORT > /dev/null 2>&1; then
    echo "Rust Proxy 端口被占用."
    lsof -ti :$RUST_PROXY_PORT | xargs kill -9 2>/dev/null
    echo "Rust Proxy 端口已释放."
fi

# 加载 bun 路径（如果已安装）
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# 检查 bun
if ! command -v bun &> /dev/null; then
    echo "安装 Bun..."
    curl -fsSL https://bun.sh/install | bash
    source "$HOME/.bun/bun.sh" 2>/dev/null || true
fi

# 安装依赖
if [ ! -d "node_modules" ]; then
    bun install --silent
fi

echo ""
echo "================================"
echo ""

# 🦀 启动 Rust Proxy
RUST_PROXY_BIN="./rust-proxy/target/release/anti-proxy"
if [ -f "$RUST_PROXY_BIN" ]; then
    echo "🦀 启动 Rust Proxy..."
    $RUST_PROXY_BIN &
    RUST_PID=$!
    sleep 1
    echo "🦀 Rust Proxy 已启动 (PID: $RUST_PID)"
else
    echo "⚠️ Rust Proxy 未编译，使用 TypeScript 模式"
fi

echo ""
echo "================================"
echo ""

# 启动 TypeScript 服务器
bun run src/main.ts start

# 清理 Rust Proxy
if [ ! -z "$RUST_PID" ]; then
    kill $RUST_PID 2>/dev/null
fi
