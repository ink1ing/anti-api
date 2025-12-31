# Anti-API

<p align="center">
  <strong>The fastest and best local API proxy service! Convert Antigravity's top AI models to OpenAI/Anthropic compatible API</strong>
</p>

<p align="center">
  <a href="#中文说明">中文说明</a> |
  <a href="#features">Features</a> |
  <a href="#quick-start">Quick Start</a> |
  <a href="#supported-models">Models</a>
</p>

---

> **Disclaimer**: This project is based on reverse engineering of Antigravity. Future compatibility is not guaranteed. For long-term use, avoid updating Antigravity.

## What's New

- Dual format support (OpenAI + Anthropic) with streaming
- Added .bat one-click launcher for Windows users
- Three exclusive remote services (ngrok/cloudflared/localtunnel) with visual panel
- All models passed tool_use tests, fully compatible with Claude Code
- OAuth expiration auto-detection and refresh
- Two free methods to get Gemini Pro access

## Features

- **Dual Format Support** - OpenAI and Anthropic compatible, both support streaming
- **Multi-Model Support** - Claude Opus 4.5 thinking / Gemini 3 Pro high / GPT-OSS 120B / ...
- **Tool Calling Support** - Function calling support, compatible with Claude Code and other CLI tools
- **Remote Access** - Tunnel management via ngrok/cloudflared/localtunnel, share quota across any device
- **Full Dashboard** - Web UI for quota and remote services `http://localhost:8964/quota` `http://localhost:8964/remote-panel`

## Free Gemini Pro Access

Two free methods to get one year of Gemini Pro:

**Method 1: Telegram Bot (Quick and stable, one-time free)**
https://t.me/sheeridverifier_bot

**Method 2: @pastking's Public Service (Unlimited, requires learning)**
https://batch.1key.me

## Quick Start

### Linux

```bash
# Install dependencies
bun install

# Start server (default port: 8964)
bun run src/main.ts start
```

### Windows

Double-click `anti-api-start.bat` to launch.

### macOS

Double-click `anti-api-start.command` to launch.

## Claude Code Configuration

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8964",
    "ANTHROPIC_AUTH_TOKEN": "any-value"
  }
}
```

## Remote Access

Access the tunnel control panel at `http://localhost:8964/remote-panel`

Supported tunnels:
- **ngrok** - Requires authtoken from ngrok.com
- **cloudflared** - Cloudflare Tunnel, no account required, high network requirements
- **localtunnel** - Open source, no account required, less stable

## Supported Models

| Model ID |
|----------|
| `claude-sonnet-4-5` |
| `claude-sonnet-4-5-thinking` |
| `claude-opus-4-5-thinking` |
| `gemini-3-flash` |
| `gemini-3-pro-high` |
| `gemini-3-pro-low` |
| `gpt-oss-120b` |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI Chat API |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | List models |
| `GET /quota` | Quota dashboard |
| `GET /remote-panel` | Tunnel control panel |
| `GET /health` | Health check |

## How It Works

```
Client (OpenAI/Anthropic) --> Anti-API (Port 8964) --> Antigravity Cloud API
```

1. First run: Opens browser for Google OAuth login
2. Translates requests to Antigravity format
3. Returns responses in OpenAI or Anthropic format

## License

MIT

---

# 中文说明

<p align="center">
  <strong>致力于成为最快最好用的API本地代理服务！将 Antigravity 内顶级大模型转换为 OpenAI/Anthropic 兼容的 API</strong>
</p>

> **免责声明**：本项目基于 Antigravity 逆向开发，未来版本兼容性未知，长久使用请尽可能避免更新Antigravity。

## 更新内容

- 同时兼容 OpenAI 和 Anthropic 格式，且均支持流式响应
- 增加 .bat 格式一键启动器，适配 Windows 用户
- 三种独家远程服务 (ngrok/cloudflared/localtunnel) 与可视化面板
- 所有模型tool_use测试均通过，完美兼容 Claude Code
- OAuth 过期自动检测和刷新。
- 提供两种免费获取 Gemini Pro 的方法

## 特性

- **双格式支持** - OpenAI 和 Anthropic 格式兼容，均支持流式响应
- **多模型支持** - Claude Opus 4.5 thinking / Gemini 3 Pro high / GPT-OSS 120B /...
- **工具调用支持** - 支持 function calling，兼容 Claude Code等Cli工具
- **远程访问** - 通过ngrok/cloudflared/localtunnel隧道管理，实现任意设备，额度共享
- **完善面板** - Web UI 查看额度和远程服务 `http://localhost:8964/quota` `http://localhost:8964/remote-panel`


## 免费获取 Gemini Pro

两种免费获取一年 Gemini Pro 的方法：

**方式1: Telegram 机器人（快速稳定，免费一次）**
https://t.me/sheeridverifier_bot

**方式2: @pastking 的公益站点（不限次数，有学习成本）**
https://batch.1key.me

## 最快速开始

### Linux

```bash
# 安装依赖
bun install

# 启动服务器（默认端口：8964）
bun run src/main.ts start
```

### Windows

双击 `anti-api-start.bat` 启动。

### macOS 

双击 `anti-api-start.command` ，首次运行会提示损坏，这是mac的保护机制
前往 系统设置 - 隐私 - 底部 - 同意打开.command脚本 - 随后再次双击 `anti-api-start.command`


## Claude Code 配置

在 `~/.claude/settings.json` 中添加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8964",
    "ANTHROPIC_AUTH_TOKEN": "任意值"
  }
}
```

## 远程访问

访问隧道控制面板：`http://localhost:8964/remote-panel`

支持的隧道服务：
- **ngrok** - 需要从 ngrok.com 获取 authtoken
- **cloudflared** - Cloudflare 隧道，无需账号，网络要求高
- **localtunnel** - 开源方案，无需账号，稳定性差

## 支持的模型

| 模型 ID |
|---------|
| `claude-sonnet-4-5` |
| `claude-sonnet-4-5-thinking` |
| `claude-opus-4-5-thinking` |
| `gemini-3-flash` |
| `gemini-3-pro-high` |
| `gemini-3-pro-low` |
| `gpt-oss-120b` |

## API 端点

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI Chat API |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | 获取模型列表 |
| `GET /quota` | 额度面板 |
| `GET /remote-panel` | 隧道控制面板 |
| `GET /health` | 健康检查 |

## 工作原理

```
客户端 (OpenAI/Anthropic) --> Anti-API (端口 8964) --> Antigravity 云 API
```

1. 首次运行：打开浏览器进行 Google OAuth 登录
2. 将请求转换为 Antigravity 格式
3. 以 OpenAI 或 Anthropic 格式返回响应

## 开源协议

MIT
