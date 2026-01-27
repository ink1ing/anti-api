# Anti-API

<p align="center">
  <strong>The fastest and best local API proxy service! Convert Antigravity's top AI models to OpenAI/Anthropic compatible API</strong>
</p>

<p align="center">
  <a href="#中文说明">中文说明</a> |
  <a href="#features">Features</a> |
  <a href="#quick-start">Quick Start</a> |
  <a href="#architecture">Architecture</a>
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Anti-API Demo" width="800">
</p>

---

> **Disclaimer**: This project is based on reverse engineering of Antigravity. Future compatibility is not guaranteed. For long-term use, avoid updating Antigravity.

## What's New (v2.4.0)

- ✅ **Streaming Optimization** - Improved stream reading to reduce unexpected interruptions
- ✅ **Docker Support** - Complete Docker deployment with one-click start scripts
- ✅ **Log Panel** - Real-time log viewer in the dashboard
- ✅ **UI Layout** - Optimized quota card layout and privacy masking
- ✅ **One-Click Scripts** - `start.command` (macOS) / `start.bat` (Windows) for native launch
- ✅ **Docker Scripts** - `dstart.command` / `dstart.bat` for Docker launch

## Features

- **🎯 Flow + Account Routing** - Custom flows for non-official models, account chains for official models
- **🌐 Remote Access** - ngrok/cloudflared/localtunnel with one-click setup
- **📊 Full Dashboard** - Quota monitoring, routing config, settings panel
- **🔄 Auto-Rotation** - Seamless account switching on 429 errors
- **⚡ Dual Format** - OpenAI and Anthropic API compatible
- **🛠️ Tool Calling** - Function calling for Claude Code and CLI tools

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

### Docker

Build:

```bash
docker build -t anti-api .
```

Run:

```bash
docker run --rm -it \\
  -p 8964:8964 \\
  -p 51121:51121 \\
  -e ANTI_API_DATA_DIR=/app/data \\
  -e ANTI_API_NO_OPEN=1 \\
  -e ANTI_API_OAUTH_NO_OPEN=1 \\
  -v $HOME/.anti-api:/app/data \\
  anti-api
```

Compose:

```bash
docker compose up --build
```

Developer override (no rebuild, use local `src/` and `public/`):

```bash
docker compose up -d --no-build
```

Notes:
- OAuth callback uses port `51121`. Make sure it is mapped.
- If running on a remote host, set `ANTI_API_OAUTH_REDIRECT_URL` to a public URL like `http://YOUR_HOST:51121/oauth-callback`.
- The bind mount reuses your local `~/.anti-api` data so Docker shares the same accounts and routing config.
- Set `ANTI_API_NO_OPEN=1` to avoid trying to open the browser inside a container.
- If Docker Hub is unstable, the default base image uses GHCR. You can override with `BUN_IMAGE=oven/bun:1.1.38`.
 - ngrok will auto-download inside the container if missing (Linux only).

## Development

- **Formatting**: follow `.editorconfig` (4-space indent, LF).
- **Tests**: `bun test`
- **Contributing**: see `docs/CONTRIBUTING.md`

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

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Anti-API (Port 8964)                   │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Dashboard   │  │   Routing    │  │   Settings   │      │
│  │   /quota     │  │   /routing   │  │   /settings  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Smart Routing System                     │  │
│  │  • Flow Routing (custom model IDs)                    │  │
│  │  • Account Routing (official model IDs)               │  │
│  │  • Auto-rotation on 429 errors                        │  │
│  │  • Multi-provider support                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                           ▼                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Antigravity  │  │    Codex     │  │   Copilot    │      │
│  │   Provider   │  │   Provider   │  │   Provider   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                           ▼
              ┌──────────────────────────┐
              │   Upstream Cloud APIs    │
              │ (Google, OpenAI, GitHub) │
              └──────────────────────────┘
```

## Smart Routing System (Beta)

> ⚠️ **Beta Feature**: Routing is experimental. Configuration may change in future versions.

The routing system is split into two modes:

- **Flow Routing**: Custom model IDs (e.g. `route:fast`) use your flow entries.
- **Account Routing**: Official model IDs (e.g. `claude-sonnet-4-5`) use per-model account chains.

This enables fine-grained control over model-to-account mapping, allowing you to:

- **Load Balance**: Distribute requests across multiple accounts
- **Model Specialization**: Route specific models to dedicated accounts
- **Provider Mixing**: Combine Antigravity, Codex, and Copilot in custom flows
- **Fallback Chains**: Automatic failover when primary accounts hit rate limits

### How It Works

```
Request
  ├─ Official model → Account Routing → Account chain → Provider → Upstream API
  └─ Custom model/route:flow → Flow Routing → Flow entries → Provider → Upstream API

No match → 400 error
```

### Configuration

1. **Access Panel**: `http://localhost:8964/routing`
2. **Flow Routing**: Create a flow (e.g., "fast", "opus"), add Provider → Account → Model entries
3. **Account Routing**: Choose an official model, set account order, optionally enable Smart Switch
4. **Use Flow**: Set `model` to `route:<flow-name>` or the flow name directly
5. **Use Official Model**: Request the official model ID directly (e.g., `claude-sonnet-4-5`)

**Example Request**:
```json
{
  "model": "route:fast",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**Flow Priority**: Entries are tried in order. If an account hits 429, the next entry is used.
**Account Routing**: If Smart Switch is on and no explicit entries exist, it expands to all supporting accounts in creation order.

---

## Remote Access

Expose your local Anti-API to the internet for cross-device access. Useful for:

- **Mobile Development**: Test AI integrations on iOS/Android
- **Team Sharing**: Share your quota with teammates
- **External Tools**: Connect AI tools that require public URLs

### Supported Tunnels

| Tunnel | Account Required | Stability | Speed |
|--------|------------------|-----------|-------|
| **ngrok** | ✅ Yes (free tier) | ⭐⭐⭐ Best | Fast |
| **cloudflared** | ❌ No | ⭐⭐ Good | Medium |
| **localtunnel** | ❌ No | ⭐ Fair | Slow |

### Setup

1. **Access Panel**: `http://localhost:8964/remote-panel`
2. **Configure** (ngrok only): Enter your authtoken from [ngrok.com](https://ngrok.com)
3. **Start Tunnel**: Click Start, wait for public URL
4. **Use Remote URL**: Replace `localhost:8964` with the tunnel URL

**Security Note**: Anyone with your tunnel URL can access your API. Keep it private.

## Settings Panel

Configure application behavior at `http://localhost:8964/settings`:

- **Auto-open Dashboard**: Open quota panel on startup
- **Auto-start ngrok**: Start tunnel automatically
- **Model Preferences**: Set default models for background tasks

## Supported Models

### Antigravity
| Model ID | Description |
|----------|-------------|
| **Claude 4.5 Series** | |
| `claude-opus-4-5-thinking` | Most capable, extended reasoning |
| `claude-sonnet-4-5` | Fast, balanced |
| `claude-sonnet-4-5-thinking` | Extended reasoning |
| `claude-haiku-4-5` | Fastest Claude |
| `claude-haiku-4-5-thinking` | Fast with reasoning |
| **Claude 4 Series** | |
| `claude-opus-4` | Opus 4 base |
| `claude-opus-4-thinking` | Opus 4 with reasoning |
| `claude-sonnet-4` | Sonnet 4 base |
| `claude-sonnet-4-thinking` | Sonnet 4 with reasoning |
| **Gemini 3 Series** | |
| `gemini-3-pro-high` | High quality |
| `gemini-3-pro-low` | Cost-effective |
| `gemini-3-pro` | Balanced |
| `gemini-3-flash` | Fastest responses |
| `gemini-3-pro-image` | Image generation (supports resolution and aspect ratio suffixes) |

**Image Generation Model Variants (21 combinations):**
| Base | 2K Resolution | 4K Resolution |
|------|---------------|---------------|
| `gemini-3-pro-image` | `gemini-3-pro-image-2k` | `gemini-3-pro-image-4k` |
| `gemini-3-pro-image-1x1` | `gemini-3-pro-image-2k-1x1` | `gemini-3-pro-image-4k-1x1` |
| `gemini-3-pro-image-4x3` | `gemini-3-pro-image-2k-4x3` | `gemini-3-pro-image-4k-4x3` |
| `gemini-3-pro-image-3x4` | `gemini-3-pro-image-2k-3x4` | `gemini-3-pro-image-4k-3x4` |
| `gemini-3-pro-image-16x9` | `gemini-3-pro-image-2k-16x9` | `gemini-3-pro-image-4k-16x9` |
| `gemini-3-pro-image-9x16` | `gemini-3-pro-image-2k-9x16` | `gemini-3-pro-image-4k-9x16` |
| `gemini-3-pro-image-21x9` | `gemini-3-pro-image-2k-21x9` | `gemini-3-pro-image-4k-21x9` |

| **Gemini 2.5 Series** | |
| `gemini-2.5-pro` | Pro 2.5 |
| `gemini-2.5-flash` | Flash 2.5 |
| `gemini-2.5-flash-thinking` | Flash with reasoning |
| `gemini-2.5-flash-lite` | Lightweight Flash |
| **Gemini 2.0 Series** | |
| `gemini-2.0-flash-exp` | Experimental Flash |
| **Other** | |
| `gpt-oss-120b` | Open source 120B |

### GitHub Copilot
| Model ID | Description |
|----------|-------------|
| `claude-opus-4-5-thinking` | Opus via Copilot |
| `claude-sonnet-4-5` | Sonnet via Copilot |
| `gpt-4o` | GPT-4o |
| `gpt-4o-mini` | GPT-4o Mini |
| `gpt-4.1` | GPT-4.1 |
| `gpt-4.1-mini` | GPT-4.1 Mini |

### ChatGPT Codex
| Model ID | Description |
|----------|-------------|
| `gpt-5.2-max-high` | 5.2 Max (High) |
| `gpt-5.2-max` | 5.2 Max |
| `gpt-5.2` | 5.2 |
| `gpt-5.2-codex` | 5.2 Codex |
| `gpt-5.1` | 5.1 |
| `gpt-5.1-codex` | 5.1 Codex |
| `gpt-5` | 5 |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI Chat API |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | List models |
| `GET /quota` | Quota dashboard |
| `GET /routing` | Routing config |
| `GET /settings` | Settings panel |
| `GET /remote-panel` | Tunnel control |
| `GET /health` | Health check |

## Code Quality & Testing

- ✅ **Unit Tests** - Core logic covered with automated tests
- ✅ **Formatting Rules** - `.editorconfig` keeps diffs consistent
- ✅ **Input Validation** - Request validation for security
- ✅ **Response Time Logging** - Performance monitoring
- ✅ **Centralized Constants** - No magic numbers
- ✅ **Comprehensive Docs** - API reference, architecture, troubleshooting

See `docs/` folder for detailed documentation.

## License

MIT

---

# 中文说明

<p align="center">
  <strong>致力于成为最快最好用的API本地代理服务！将 Antigravity 内模型配额转换为 OpenAI/Anthropic 兼容的 API</strong>
</p>

> **免责声明**：本项目基于 Antigravity 逆向开发，未来版本兼容性未知，长久使用请尽可能避免更新Antigravity。

## 更新内容 (v2.5.0)

- ✅ **配额保留功能** - 设置配额保留百分比，账户配额低于阈值时自动切换下一个账户，避免榨干所有账户
- ✅ **Docker 部署优化** - 修复 Docker 环境下 OAuth 登录问题，支持非阻塞式授权流程
- ✅ **日志系统改进** - 支持 `ANTI_API_VERBOSE` 环境变量，默认显示 info 级别日志
- ✅ **前端兼容性修复** - 修复 HTTP 环境下 UUID 生成问题，修复远程访问时 API 地址问题

## 特性

- **🎯 Flow + Account 路由** - 自定义流控制非官方模型，官方模型使用账号链
- **🌐 远程访问** - ngrok/cloudflared/localtunnel 一键设置
- **📊 完整面板** - 配额监控、路由配置、设置面板
- **🔄 自动轮换** - 429 错误时无缝切换账号
- **⚡ 双格式支持** - OpenAI 和 Anthropic API 兼容
- **🛠️ 工具调用** - 支持 function calling，兼容 Claude Code
- **🔋 配额保留** - 设置保留百分比，避免用尽所有账户配额

## Docker 部署（推荐）

### docker-compose.yml 配置示例

```yaml
services:
  anti-api:
    image: ghcr.io/your-username/anti-api:latest
    container_name: anti-api
    restart: unless-stopped
    ports:
      - "8964:8964"
      - "51121:51121"
    environment:
      HOME: /app/data
      ANTI_API_VERBOSE: "1"
      ANTI_API_OAUTH_NO_OPEN: "1"
      ANTI_API_NO_OPEN: "1"
      TZ: Asia/Shanghai
      # 如需代理访问 Google API，添加以下配置
      HTTP_PROXY: "http://your-proxy:7890"
      HTTPS_PROXY: "http://your-proxy:7890"
      NO_PROXY: "localhost,127.0.0.1,192.168.0.0/16"
    volumes:
      - ./anti-api/data:/app/data
```

### 首次使用 - Windows 端口转发配置

由于 Google OAuth 只允许 `localhost` 作为回调地址，Docker 部署时需要在 Windows 上设置端口转发：

```powershell
# 添加端口转发（管理员权限运行 PowerShell）
netsh interface portproxy add v4tov4 listenport=51121 connectaddress=192.168.1.15 connectport=51121 listenaddress=127.0.0.1

# 查看当前端口转发规则
netsh interface portproxy show all

# 删除端口转发（不再需要时）
netsh interface portproxy delete v4tov4 listenport=51121 listenaddress=127.0.0.1
```

> **注意**：将 `192.168.1.15` 替换为你的 Docker 服务器 IP 地址。

### 启动容器

```bash
docker compose pull anti-api && docker compose up -d anti-api
```

### 添加账户

1. 访问 `http://你的服务器IP:8964/quota`
2. 点击 "Add" → 选择 "Antigravity"
3. 浏览器会自动打开 Google 登录页面
4. 完成登录后，页面会自动检测并显示账户信息

## 配额保留功能

避免把所有账户的配额都榨干，保留一定百分比用于紧急情况。

### 配置方法

1. 访问 `http://你的服务器IP:8964/quota`
2. 切换到 **Settings** 标签页
3. 找到 **Quota Reserve** 设置
4. 输入保留百分比（推荐 5-10%）
5. 点击 **Save** 保存

### 工作原理

- 设置为 `5%`：当账户配额降到 5% 或以下时，跳过该账户使用下一个
- 设置为 `0%`：禁用此功能，用尽才切换（默认）
- **只在有多个账户时生效**

### 智能匹配

系统会根据请求的模型类型匹配对应的配额：
- Claude/GPT 模型 → 检查 `claude_gpt` 配额
- Gemini Pro 模型 → 检查 `gpro` 配额
- Gemini Flash 模型 → 检查 `gflash` 配额

## 路由系统说明

### Account Routing（账户路由）

用于**官方模型**（如 `claude-sonnet-4-5`）配置使用哪些账户：

- 当请求官方模型时，系统会根据配置的账户列表**轮换使用**
- 如果一个账户配额用完或达到保留阈值，自动切换到下一个
- 开启 "Smart Switch" 后，系统会自动使用所有可用账户

### Flow Routing（流路由）

用于创建**自定义模型名称**的路由规则：

- 创建一个 Flow 叫 `my-smart-model`
- 在里面配置多个实际模型（如先用 Antigravity 的 Claude，失败了就切换到 Copilot）
- 在客户端使用 `route:my-smart-model` 作为模型名
- 系统会按顺序尝试，第一个失败就用下一个

## 开发规范

- **格式规范**：遵循 `.editorconfig`（4 空格缩进、LF 行尾）
- **测试**：运行 `bun test`
- **贡献指南**：参考 `docs/CONTRIBUTING.md`

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Anti-API (端口 8964)                   │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   配额面板   │  │   路由配置   │  │   设置面板   │      │
│  │   /quota     │  │   /routing   │  │   /settings  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              智能路由系统                             │  │
│  │  • Flow 路由（自定义模型 ID）                         │  │
│  │  • Account 路由（官方模型 ID）                        │  │
│  │  • 429 错误自动轮换                                   │  │
│  │  • 配额保留自动切换                                   │  │
│  │  • 多提供商支持                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                           ▼                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Antigravity  │  │    Codex     │  │   Copilot    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## 远程访问

将本地 Anti-API 暴露到公网，支持跨设备访问：

- **移动开发** - iOS/Android 测试 AI 集成
- **团队共享** - 与队友共享配额
- **外部工具** - 连接需要公网 URL 的 AI 工具

### 隧道对比

| 隧道 | 需要账号 | 稳定性 | 速度 |
|------|----------|--------|------|
| **ngrok** | ✅ 是 | ⭐⭐⭐ 最佳 | 快 |
| **cloudflared** | ❌ 否 | ⭐⭐ 良好 | 中 |
| **localtunnel** | ❌ 否 | ⭐ 一般 | 慢 |

### 设置方法

1. **访问面板**: `http://localhost:8964/remote-panel`
2. **配置** (ngrok): 输入 [ngrok.com](https://ngrok.com) 的 authtoken
3. **启动隧道**: 点击启动，等待公网 URL
4. **使用远程 URL**: 用隧道 URL 替换 `localhost:8964`

**安全提示**: 任何人拥有隧道 URL 即可访问您的 API，请妥善保管。

## 设置面板

访问 `http://你的服务器IP:8964/quota` → Settings 标签页：

| 设置项 | 说明 |
|--------|------|
| Preload Routing | 后台预加载路由页面 |
| Auto Start ngrok | 启动时自动开启隧道 |
| Auto Open Dashboard | 启动时打开浏览器 |
| Auto Refresh Quota | 每 10 分钟自动刷新配额 |
| Privacy Protection | 遮罩邮箱和用户名 |
| Compact Layout | 紧凑布局模式 |
| Track Token Usage | 统计 Token 使用量 |
| Capture Logs | 捕获日志到面板 |
| Optimize Quota Sorting | 按剩余配额排序账户 |
| **Quota Reserve** | **配额保留百分比（0-50%）** |

## 支持的模型

### Antigravity
| 模型 ID | 说明 |
|---------|------|
| **Claude 4.5 系列** | |
| `claude-opus-4-5-thinking` | 最强能力，扩展推理 |
| `claude-sonnet-4-5` | 快速均衡 |
| `claude-sonnet-4-5-thinking` | 扩展推理 |
| `claude-haiku-4-5` | 最快的 Claude |
| `claude-haiku-4-5-thinking` | 快速推理 |
| **Claude 4 系列** | |
| `claude-opus-4` | Opus 4 基础版 |
| `claude-opus-4-thinking` | Opus 4 推理版 |
| `claude-sonnet-4` | Sonnet 4 基础版 |
| `claude-sonnet-4-thinking` | Sonnet 4 推理版 |
| **Gemini 3 系列** | |
| `gemini-3-pro-high` | 高质量 |
| `gemini-3-pro-low` | 低配额消耗 |
| `gemini-3-pro` | 均衡版 |
| `gemini-3-flash` | 最快响应 |
| `gemini-3-pro-image` | 图像生成 (支持分辨率和宽高比后缀) |

**图像生成模型变体 (21种组合):**
| 基础版 | 2K 分辨率 | 4K 分辨率 |
|--------|-----------|-----------|
| `gemini-3-pro-image` | `gemini-3-pro-image-2k` | `gemini-3-pro-image-4k` |
| `gemini-3-pro-image-1x1` | `gemini-3-pro-image-2k-1x1` | `gemini-3-pro-image-4k-1x1` |
| `gemini-3-pro-image-4x3` | `gemini-3-pro-image-2k-4x3` | `gemini-3-pro-image-4k-4x3` |
| `gemini-3-pro-image-3x4` | `gemini-3-pro-image-2k-3x4` | `gemini-3-pro-image-4k-3x4` |
| `gemini-3-pro-image-16x9` | `gemini-3-pro-image-2k-16x9` | `gemini-3-pro-image-4k-16x9` |
| `gemini-3-pro-image-9x16` | `gemini-3-pro-image-2k-9x16` | `gemini-3-pro-image-4k-9x16` |
| `gemini-3-pro-image-21x9` | `gemini-3-pro-image-2k-21x9` | `gemini-3-pro-image-4k-21x9` |

| **Gemini 2.5 系列** | |
| `gemini-2.5-pro` | Pro 2.5 |
| `gemini-2.5-flash` | Flash 2.5 |
| `gemini-2.5-flash-thinking` | Flash 推理版 |
| `gemini-2.5-flash-lite` | 轻量版 Flash |
| **Gemini 2.0 系列** | |
| `gemini-2.0-flash-exp` | 实验版 Flash |
| **其他** | |
| `gpt-oss-120b` | 开源 120B 模型 |

### GitHub Copilot
| 模型 ID | 说明 |
|---------|------|
| `claude-opus-4-5-thinking` | Opus |
| `claude-sonnet-4-5` | Sonnet |
| `claude-sonnet-4-5-thinking` | Sonnet Thinking |
| `gpt-4o` | GPT-4o |
| `gpt-4o-mini` | GPT-4o Mini |
| `gpt-4.1` | GPT-4.1 |
| `gpt-4.1-mini` | GPT-4.1 Mini |

### ChatGPT Codex
| 模型 ID | 说明 |
|---------|------|
| `gpt-5.2` | 5.2 |
| `gpt-5.2-codex` | 5.2 Codex |
| `gpt-5.1` | 5.1 |
| `gpt-5.1-codex` | 5.1 Codex |
| `gpt-5.1-codex-max` | 5.1 Codex Max |
| `gpt-5.1-codex-mini` | 5.1 Codex Mini |
| `gpt-5` | 5 |
| `gpt-5-codex` | 5 Codex |
| `gpt-5-codex-mini` | 5 Codex Mini |

## API 端点

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI Chat API |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /v1/models` | 模型列表 |
| `GET /quota` | 配额面板 |
| `GET /routing` | 路由配置 |
| `GET /settings` | 设置 API |
| `GET /remote-panel` | 隧道控制 |
| `GET /health` | 健康检查 |

## 常见问题

### Docker 环境下 OAuth 登录失败

确保：
1. 已配置端口转发（见上文 Windows 端口转发配置）
2. 容器已映射 51121 端口
3. 如需访问 Google API，已配置 HTTP_PROXY

### 看不到日志输出

设置环境变量 `ANTI_API_VERBOSE=1` 或使用 `-v` 参数启动。

### 配额保留不生效

- 确保有多个账户（单账户不会被跳过）
- 确保开启了 Auto Refresh Quota 以保持配额数据最新
- 配额数据来自缓存，首次使用时可能为空

## 开源协议

MIT
