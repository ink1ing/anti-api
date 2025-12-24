# Anti-API

<p align="center">
  <strong>Expose Antigravity's built-in AI models as an Anthropic-compatible API</strong>
</p>

<p align="center">
  <a href="#中文说明">中文说明</a> •
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#supported-models">Models</a>
</p>

---

> ⚠️ **Disclaimer**: This project is based on reverse engineering of Antigravity. Future compatibility is not guaranteed. Use at your own risk. Not officially supported.

## Features

- 🚀 **Full Model Support** - Access Opus 4.5 Thinking, Sonnet 4.5 Thinking, Gemini 3 Pro High and more
- 🔌 **Anthropic API Compatible** - Works with Claude Code, Cherry Studio, ChatWise, Obsidian Copilot
- 📊 **Quota Dashboard** - Built-in web UI to monitor model usage at `http://localhost:8964`
- ⚡ **One-Click Start** - Double-click `start.command` to launch
- 🪶 **Lightweight** - Minimal memory footprint
- 🔒 **Local Only** - All requests stay on your machine

## Requirements

- [Antigravity](https://antigravity.dev) installed and **logged in**
- Valid **Google AI subscription** (for model access)
- [Bun](https://bun.sh) runtime

## Quick Start

```bash
# Install dependencies
bun install

# Start the server (default port: 8964)
./start.command
# or
bun run src/main.ts start
```

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

Or use environment variables:

```bash
ANTHROPIC_BASE_URL=http://localhost:8964 \
ANTHROPIC_API_KEY=any-value \
claude
```

## Supported Models

### Claude
| Model | Description |
|-------|-------------|
| `claude-opus-4-5-thinking` | Claude Opus 4.5 (Thinking) ⭐ |
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 (Thinking) ⭐ |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 |
| `claude-haiku-4-5` | Claude Haiku 4.5 |

### Gemini
| Model | Description |
|-------|-------------|
| `gemini-3-pro-high` | Gemini 3 Pro (High) ⭐ |
| `gemini-3-pro-low` | Gemini 3 Pro (Low) |
| `gemini-3-flash` | Gemini 3 Flash |
| `gemini-2-5-pro` | Gemini 2.5 Pro |

### Other
| Model | Description |
|-------|-------------|
| `gpt-oss-120b` | GPT-OSS 120B |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /quota` | Quota dashboard (Web UI) |
| `GET /quota/json` | Quota data (JSON) |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | List available models |
| `GET /health` | Health check |

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌────────────────────┐
│ Claude Code │────▶│  Anti-API    │────▶│ Antigravity Server │
│  (Client)   │◀────│  (Port 8964) │◀────│ (Language Server)  │
└─────────────┘     └──────────────┘     └────────────────────┘
```

1. Anti-API discovers the local Antigravity Language Server
2. Translates Anthropic API requests to Antigravity's Cascade format
3. Polls for AI responses and returns them in Anthropic format

## Development

```bash
# Build
bun run build

# Run with verbose logging
bun run src/main.ts start --verbose

# Specify custom port
bun run src/main.ts start --port 9000
```

## Acknowledgements

Inspired by [copilot-api](https://github.com/nicepkg/copilot-api).

## License

MIT

---

# 中文说明

<p align="center">
  <strong>将 Antigravity 内置的 AI 模型暴露为 Anthropic 兼容的 API</strong>
</p>

> ⚠️ **免责声明**：本项目基于 Antigravity 最新版本逆向开发，未来新版本的可用性未知。未受官方支持，使用风险自负。

## 特性

- 🚀 **完整模型支持** - 支持 Opus 4.5 Thinking / Sonnet 4.5 Thinking / Gemini 3 Pro High 等模型
- 🔌 **Anthropic API 兼容** - 支持 Claude Code、Cherry Studio、ChatWise、Obsidian Copilot 等工具
- 📊 **额度查看面板** - 内置 Web UI，访问 `http://localhost:8964` 即可查看
- ⚡ **一键启动** - 双击 `start.command` 即可运行
- 🪶 **极低内存占用** - 轻量级设计
- 🔒 **本地运行** - 所有请求都在本地处理

## 前置要求

- 安装 [Antigravity](https://antigravity.dev) 并**登录账号**
- 有效的 **Google AI 订阅**（用于模型访问）
- 安装 [Bun](https://bun.sh) 运行时

## 快速开始

```bash
# 安装依赖
bun install

# 启动服务器（默认端口：8964）
./start.command
# 或者
bun run src/main.ts start
```

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

或使用环境变量：

```bash
ANTHROPIC_BASE_URL=http://localhost:8964 \
ANTHROPIC_API_KEY=任意值 \
claude
```

## 支持的模型

### Claude
| 模型 ID | 说明 |
|---------|------|
| `claude-opus-4-5-thinking` | Claude Opus 4.5（思考模式）⭐ |
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5（思考模式）⭐ |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 |
| `claude-haiku-4-5` | Claude Haiku 4.5 |

### Gemini
| 模型 ID | 说明 |
|---------|------|
| `gemini-3-pro-high` | Gemini 3 Pro（高配）⭐ |
| `gemini-3-pro-low` | Gemini 3 Pro（低配） |
| `gemini-3-flash` | Gemini 3 Flash |
| `gemini-2-5-pro` | Gemini 2.5 Pro |

### 其他
| 模型 ID | 说明 |
|---------|------|
| `gpt-oss-120b` | GPT-OSS 120B |

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /quota` | 额度面板（Web UI） |
| `GET /quota/json` | 额度数据（JSON） |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | 获取可用模型列表 |
| `GET /health` | 健康检查 |

## 工作原理

```
┌─────────────┐     ┌──────────────┐     ┌────────────────────┐
│ Claude Code │────▶│  Anti-API    │────▶│ Antigravity 服务器  │
│  （客户端）   │◀────│ （端口 8964）  │◀────│  （语言服务器）      │
└─────────────┘     └──────────────┘     └────────────────────┘
```

1. Anti-API 发现本地 Antigravity 语言服务器
2. 将 Anthropic API 请求转换为 Antigravity 的 Cascade 格式
3. 轮询 AI 响应并以 Anthropic 格式返回

## 开源协议

MIT
