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

# 检查端口占用
if lsof -i :$PORT > /dev/null 2>&1; then
    echo "端口: $PORT"
    lsof -ti :$PORT | xargs kill -9 2>/dev/null
    echo "端口被占用但已释放."
else
    echo "端口: $PORT"
fi

# 检查 bun
if ! command -v bun &> /dev/null; then
    echo "安装 Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
fi

# 安装依赖
if [ ! -d "node_modules" ]; then
    bun install --silent
fi

echo "anti-api已启动."
echo ""
echo "================================"
echo ""
echo "配额面板:"
echo "http://localhost:$PORT/quota"
echo ""
echo "================================"
echo ""

bun run src/main.ts start
