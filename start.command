#!/bin/bash

# Anti-API 一键启动脚本
# 双击运行即可启动服务

cd "$(dirname "$0")"

echo "================================"
echo "    Anti-API 启动中..."
echo "================================"
echo ""

# 杀掉之前运行的 anti-api 进程
if pgrep -f "bun.*anti-api\|bun.*main.ts" > /dev/null; then
    echo "🔄 检测到已运行的 Anti-API 进程，正在关闭..."
    pkill -f "bun.*anti-api\|bun.*main.ts" 2>/dev/null
    sleep 1
    echo "   已关闭旧进程"
    echo ""
fi

# 检查端口是否被占用
if lsof -i :8964 > /dev/null 2>&1; then
    echo "🔄 端口 8964 被占用，正在释放..."
    lsof -ti :8964 | xargs kill -9 2>/dev/null
    sleep 1
fi

# 检查 Antigravity 是否运行
if ! pgrep -f "Antigravity" > /dev/null; then
    echo "⚠️  警告: Antigravity 应用未运行"
    echo "   请先启动 Antigravity 并登录账户"
    echo ""
    read -p "按 Enter 继续尝试启动..."
fi

# 检查 bun 是否安装
if ! command -v bun &> /dev/null; then
    echo "❌ 错误: 未找到 bun"
    echo "   请先安装: curl -fsSL https://bun.sh/install | bash"
    echo ""
    read -p "按 Enter 退出..."
    exit 1
fi

# 安装依赖（如果需要）
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    bun install
    echo ""
fi

echo "🚀 启动 Anti-API 服务器..."
echo ""
echo "================================"
echo "  端口: 8964"
echo "  Claude Code 配置:"
echo "    ANTHROPIC_BASE_URL=http://localhost:8964"
echo "    ANTHROPIC_AUTH_TOKEN=任意值"
echo "================================"
echo ""
echo "按 Ctrl+C 停止服务"
echo ""

# 启动服务器（前台运行，关闭窗口即停止）
exec bun run src/main.ts start
