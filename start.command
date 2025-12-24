#!/bin/bash

# Anti-API 一键启动脚本
# 双击运行即可启动服务（自动安装依赖）

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

# 检查 bun 是否安装，如果没有则自动安装
if ! command -v bun &> /dev/null; then
    echo "📦 未检测到 Bun，正在自动安装..."
    echo ""
    curl -fsSL https://bun.sh/install | bash
    
    # 添加 bun 到当前 shell 的 PATH
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    
    # 验证安装
    if ! command -v bun &> /dev/null; then
        echo ""
        echo "❌ Bun 安装失败，请手动安装"
        echo "   访问: https://bun.sh"
        read -p "按 Enter 退出..."
        exit 1
    fi
    
    echo ""
    echo "✅ Bun 安装成功！"
    echo ""
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
echo "  面板: http://localhost:8964"
echo "================================"
echo ""
echo "按 Ctrl+C 停止服务"
echo ""

# 启动服务器（前台运行，关闭窗口即停止）
exec bun run src/main.ts start
