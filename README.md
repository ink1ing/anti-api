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

## What's New (v2.7.0)

- **Antigravity proxy notice** - Google has officially prohibited reverse-proxy usage of its AI services. The Antigravity reverse proxy still works for now but is **no longer recommended**
- **Codex & Copilot unaffected** - Reverse-proxy services for Codex and GitHub Copilot remain fully functional and are not subject to the restriction above
- **Log IDE Out** - New one-click action to sign out of the Antigravity IDE (closes the IDE, clears auth, ready for a different account)

## 更新说明 (v2.7.0)

- **Antigravity 代理风险提示** - Google 已明确禁止对其 AI 服务进行反向代理。Antigravity 反代目前仍可用，但**不建议继续使用**
- **Codex & Copilot 不受影响** - Codex 和 GitHub Copilot 的反代服务正常运行，不受上述限制
- **一键登出 IDE** - 新增 Log IDE Out 功能，关闭 Antigravity IDE 并清除登录态，方便快速切换账号

<details>
<summary>v2.6.2</summary>

- **Per-request log context isolation** - Error logs no longer mix model/account under concurrency
- **Copilot TLS hardening** - Default TLS verification restored; optional `ANTI_API_COPILOT_INSECURE_TLS=1` for restricted networks
- **Codex TLS hardening** - Default TLS verification restored; optional `ANTI_API_CODEX_INSECURE_TLS=1` for restricted networks
- **Routing config resilience** - Soft timeouts and caching for Copilot model sync and quota aggregation
- **Dynamic model sync** - Routing now syncs Codex/Copilot model lists from authenticated accounts with static fallback
- **Test baseline fixes** - `bun test ./test` avoids legacy folders; updated mocks and default settings

</details>

<details>
<summary>v2.6.2 中文</summary>

- **请求日志隔离** - 并发下日志不再串号，模型与账号可准确对应
- **Copilot TLS 加固** - 默认启用证书校验；受限网络可用 `ANTI_API_COPILOT_INSECURE_TLS=1` 临时兼容
- **Codex TLS 加固** - 默认启用证书校验；受限网络可用 `ANTI_API_CODEX_INSECURE_TLS=1` 临时兼容
- **路由加载更稳** - Copilot 模型同步与配额聚合加入软超时与缓存
- **动态模型同步** - 路由可从已登录账号同步 Codex/Copilot 模型并保留静态兜底
- **测试基线修复** - `bun test ./test` 避免历史目录干扰，修复 mock 与默认设置断言

</details>

## Features

- **Flow + Account Routing** - Custom flows for non-official models, account chains for official models
- **Remote Access** - ngrok/cloudflared/localtunnel with one-click setup
- **Full Dashboard** - Quota monitoring, routing config, settings panel
- **Auto-Rotation** - Account switching on 429 errors
- **Dual Format** - OpenAI and Anthropic API compatible
- **Tool Calling** - Function calling for Claude Code and CLI tools

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
- If Copilot TLS fails in restricted networks, set `ANTI_API_COPILOT_INSECURE_TLS=1` (not recommended for general use).
- If Codex TLS fails in restricted networks, set `ANTI_API_CODEX_INSECURE_TLS=1` (not recommended for general use).
- Set Codex default reasoning effort with `ANTI_API_CODEX_REASONING_EFFORT=low|medium|high` (default: `medium`).
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

> **Beta Feature**: Routing is experimental. Configuration may change in future versions.

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
| **ngrok** | Yes (free tier) | Best | Fast |
| **cloudflared** | No | Good | Medium |
| **localtunnel** | No | Fair | Slow |

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
| `claude-sonnet-4-5` | Fast, balanced |
| `claude-sonnet-4-5-thinking` | Extended reasoning |
| `claude-opus-4-5-thinking` | Most capable |
| `claude-opus-4-6-thinking` | Most capable (new generation) |
| `gemini-3-flash` | Fastest responses |
| `gemini-3-pro-high` | High quality |
| `gemini-3-pro-low` | Cost-effective |
| `gpt-oss-120b` | Open source |

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
| `gpt-5.3-max-high` | 5.3 Max (High) |
| `gpt-5.3-max` | 5.3 Max |
| `gpt-5.3` | 5.3 |
| `gpt-5.3-codex` | 5.3 Codex |
| `gpt-5.2-max-high` | 5.2 Max (High) |
| `gpt-5.2-max` | 5.2 Max |
| `gpt-5.2` | 5.2 |
| `gpt-5.2-codex` | 5.2 Codex |
| `gpt-5.1` | 5.1 |
| `gpt-5.1-codex` | 5.1 Codex |
| `gpt-5` | 5 |

Codex reasoning effort support:
- Global default: `ANTI_API_CODEX_REASONING_EFFORT=low|medium|high` (default: `medium`)
- Per request (`/v1/chat/completions`): `reasoning_effort` or `reasoning.effort`

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

- **Unit Tests** - Core logic covered with automated tests
- **Formatting Rules** - `.editorconfig` keeps diffs consistent
- **Input Validation** - Request validation for security
- **Response Time Logging** - Performance monitoring
- **Centralized Constants** - No magic numbers
- **Comprehensive Docs** - API reference, architecture, troubleshooting

See `docs/` folder for detailed documentation.

## License

MIT

---

# 中文说明

<p align="center">
  <strong>致力于成为最快最好用的API本地代理服务！将 Antigravity 内模型配额转换为 OpenAI/Anthropic 兼容的 API</strong>
</p>

> **免责声明**：本项目基于 Antigravity 逆向开发，未来版本兼容性未知，长久使用请尽可能避免更新Antigravity。

## 更新内容 (v2.5.1)

- **凭证导入导出下线说明** - 账号 JSON 凭证导入导出已在后续版本移除，不再提供该功能
- **路由继承** - 支持直接使用当前 active flow
- **路由刷新** - routing 页面新增刷新按钮
- **配额稳定性** - `usage_limit_reached` 统一视为额度耗尽，触发自动切换
- **Antigravity 兼容** - 统一 User-Agent 版本为 1.15.8，避免版本过旧拦截
- **一键更新** - 使用 `./a --update` 或 `start.command --update` 直接覆盖更新并保留数据

## 特性

- **Flow + Account 路由** - 自定义流控制非官方模型，官方模型使用账号链
- **远程访问** - ngrok/cloudflared/localtunnel 一键设置
- **完整面板** - 配额监控、路由配置、设置面板
- **自动轮换** - 429 错误时切换账号
- **双格式支持** - OpenAI 和 Anthropic API 兼容
- **工具调用** - 支持 function calling，兼容 Claude Code

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
│  │  • 多提供商支持                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                           ▼                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Antigravity  │  │    Codex     │  │   Copilot    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## 智能路由系统 (Beta)

> **测试功能**：路由系统为实验性功能，配置格式可能在未来版本中变更。

路由系统拆分为两种模式：

- **Flow 路由**：自定义模型 ID（如 `route:fast`）使用流配置
- **Account 路由**：官方模型 ID（如 `claude-sonnet-4-5`）使用账号链

由此实现模型到账号的精细控制：

- **负载均衡** - 将请求分发到多个账号
- **模型专用** - 指定模型使用专用账号
- **混合提供商** - 组合 Antigravity、Codex、Copilot
- **自动降级** - 账号触发 429 时自动切换下一个

### 工作流程

```
请求
  ├─ 官方模型 → Account 路由 → 账号链 → 提供商 → 上游 API
  └─ 自定义模型/route:flow → Flow 路由 → 流条目 → 提供商 → 上游 API

无匹配 → 400 错误
```

### 配置方法

1. **访问面板**: `http://localhost:8964/routing`
2. **Flow 路由**: 创建流（如 "fast", "opus"），添加 提供商 → 账号 → 模型 条目
3. **Account 路由**: 选择官方模型，配置账号顺序，按需开启 Smart Switch
4. **使用流**: 设置 `"model": "route:<流名称>"` 或直接使用流名
5. **使用官方模型**: 直接请求官方模型 ID（如 `claude-sonnet-4-5`）

**Flow 顺序**：按配置顺序尝试，429 时切换下一个。
**Account 路由**：Smart Switch 开启且未配置条目时，按账号创建顺序自动展开。

---

## 远程访问

将本地 Anti-API 暴露到公网，支持跨设备访问：

- **移动开发** - iOS/Android 测试 AI 集成
- **团队共享** - 与队友共享配额
- **外部工具** - 连接需要公网 URL 的 AI 工具

### 隧道对比

| 隧道 | 需要账号 | 稳定性 | 速度 |
|------|----------|--------|------|
| **ngrok** | 是（免费层） | 最佳 | 快 |
| **cloudflared** | 否 | 良好 | 中 |
| **localtunnel** | 否 | 一般 | 慢 |

### 设置方法

1. **访问面板**: `http://localhost:8964/remote-panel`
2. **配置** (ngrok): 输入 [ngrok.com](https://ngrok.com) 的 authtoken
3. **启动隧道**: 点击启动，等待公网 URL
4. **使用远程 URL**: 用隧道 URL 替换 `localhost:8964`

**安全提示**: 任何人拥有隧道 URL 即可访问您的 API，请妥善保管。

## 设置面板

访问 `http://localhost:8964/settings` 配置：

- **自动打开面板**: 启动时打开配额面板
- **自动启动 ngrok**: 自动启动隧道
- **模型偏好**: 设置后台任务默认模型

## 支持的模型

### Antigravity
| 模型 ID | 说明 |
|---------|------|
| `claude-sonnet-4-5` | 快速均衡 |
| `claude-sonnet-4-5-thinking` | 扩展推理 |
| `claude-opus-4-5-thinking` | 最强能力 |
| `claude-opus-4-6-thinking` | 最强能力（新一代） |
| `gemini-3-flash` | 最快响应 |
| `gemini-3-pro-high` | 高质量 |

### GitHub Copilot
| 模型 ID | 说明 |
|---------|------|
| `claude-opus-4-5-thinking` | Opus |
| `claude-sonnet-4-5` | Sonnet |
| `gpt-4o` | GPT-4o |
| `gpt-4o-mini` | GPT-4o Mini |
| `gpt-4.1` | GPT-4.1 |

### ChatGPT Codex
| 模型 ID | 说明 |
|---------|------|
| `gpt-5.3-max-high` | 5.3 Max (High) |
| `gpt-5.3-max` | 5.3 Max |
| `gpt-5.3` | 5.3 |
| `gpt-5.3-codex` | 5.3 Codex |
| `gpt-5.2-max-high` | 5.2 Max (High) |
| `gpt-5.2-max` | 5.2 Max |
| `gpt-5.2` | 5.2 |
| `gpt-5.1` | 5.1 |
| `gpt-5` | 5 |

Codex 推理强度支持：
- 全局默认：`ANTI_API_CODEX_REASONING_EFFORT=low|medium|high`（默认 `medium`）
- 单次请求（OpenAI `/v1/chat/completions`）：`reasoning_effort` 或 `reasoning.effort`

## API 端点

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI Chat API |
| `POST /v1/messages` | Anthropic Messages API |
| `GET /quota` | 配额面板 |
| `GET /routing` | 路由配置 |
| `GET /settings` | 设置面板 |
| `GET /remote-panel` | 隧道控制 |

## 代码质量

- **单元测试** - 核心逻辑完整测试
- **输入验证** - 请求验证保障安全
- **响应时间日志** - 性能监控
- **常量集中管理** - 无魔法数字

详细文档见 `docs/` 文件夹。

## 开源协议

MIT
