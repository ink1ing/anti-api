# Anti-API

<p align="center">
  <strong>An independent local protocol-compatibility and routing proxy for OpenAI- and Anthropic-style clients</strong>
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

> **Scope and authorization**: Anti-API is an independent, unofficial interoperability project. Some integrations use provider CLI, web, or internal endpoints and may break without notice. Compatibility does not imply provider affiliation or endorsement. Use only accounts and services you own or are explicitly authorized to administer, subject to each provider's current terms. Do not disable security updates or provider controls to preserve compatibility.

## What's New (v3.1.0)

- **Grok provider support** - Added xAI Grok via the Grok CLI reverse proxy (`cli-chat-proxy.grok.com`, OpenAI Responses API), with account import, model routing, and quota-store integration alongside existing providers
- **Two Grok models exposed** - The standard ModelName `grok-build` (shown as **Xbuild**; this maps to the actual **Grok 4.3** model, as visible inside the Grok CLI) and `grok-composer-2.5-fast` (Composer 2.5 Fast)
- **Explicit credential import** - Grok can import an existing local CLI session after user action; no standalone login flow is added. Provider policy, quota, and account-enforcement decisions still apply.

<details>
<summary>v3.0.0</summary>

- **Kiro provider support** - Added Kiro account import, quota visibility, model routing, and reverse-proxy support alongside existing providers
- **Dashboard i18n** - Added global Chinese support, system-language default detection, and a Settings language switch
- **Account diagnostics assistant** - Added a localhost-only diagnostics panel for checking missing account files, CLI tools, callback ports, and provider setup
- **Panel updates** - Added a localhost-only update checker and source-install updater, with package-manager safeguards for WinGet and Docker
- **Docker support hardened** - Updated Docker defaults, OAuth port ranges, health checks, development compose separation, and Docker-specific update guidance

</details>

<details>
<summary>v2.9.0</summary>

- **Stable Homebrew package** - Homebrew now installs a prebuilt macOS Apple Silicon bundle, so `brew install anti-api` no longer depends on local Rust, LLVM, or Bun downloads
- **WinGet distribution pipeline** - Added Windows portable packaging, WinGet manifest generation, and release workflow for `winget install anti-api`
- **Unified launcher behavior** - Homebrew and WinGet installs now share the same contract: `anti-api` starts the service directly in any terminal
- **Portable runtime support** - Added a Windows portable entrypoint that starts the Rust proxy, serves the bundled dashboard files, and avoids package-manager self-update conflicts
- **Package-manager safeguards** - Homebrew/WinGet installs now redirect updates to `brew upgrade anti-api` and `winget upgrade anti-api` instead of self-overwriting

</details>

<details>
<summary>v2.8.0</summary>

- **Zed hosted-model support** - Anti-API can now import the current Zed.app login state and route requests to Zed-hosted models
- **Per-account dynamic model fetch** - Routing fetches live models from each available Codex and Copilot account, and now includes Zed account-level model sync
- **Zed account behavior clarified** - Zed accounts can be imported one by one and kept in Anti-API, but they cannot be bulk auto-discovered like Codex/Copilot
- **Zed quota widget updated** - The Zed card now shows shared all-model support status and billing-period timing instead of misleading remaining-credit percentages
- **Zed stability hardening** - Added request timeouts and success-state recovery for Zed account fetch, model sync, and completion requests

</details>

<details>
<summary>v2.7.1</summary>

- **Per-account model fetch (Routing)** - Model lists are now fetched from each logged-in Codex/Copilot account instead of relying on static presets
- **Antigravity fetch integration (single account)** - Routing now attempts live model fetch from the first available Antigravity account and falls back safely when unavailable
- **Account-level model map in `/routing/config`** - Added `accountModels` so the UI can render account-specific model lists directly
- **Routing panel model rendering update** - Account cards now show models from fetched account-level data first, then fallback models

</details>

<details>
<summary>v2.7.0</summary>

- **Antigravity policy notice** - This unofficial integration may conflict with current provider terms. Its presence in the codebase is not a representation that a particular use is permitted; verify the applicable terms before use.
- **Separate provider terms** - Codex and GitHub Copilot are governed by their own current terms. Anti-API makes no blanket claim that any provider integration is authorized or unaffected by policy changes.
- **Log IDE Out** - New one-click action to sign out of the Antigravity IDE (closes the IDE, clears auth, ready for a different account)

</details>

<details>
<summary>v2.6.2</summary>

- **Per-request log context isolation** - Error logs no longer mix model/account under concurrency
- **Copilot TLS hardening** - Default TLS verification restored; optional `ANTI_API_COPILOT_INSECURE_TLS=1` for restricted networks
- **Codex TLS hardening** - Default TLS verification restored; optional `ANTI_API_CODEX_INSECURE_TLS=1` for restricted networks
- **Routing config resilience** - Soft timeouts and caching for Copilot model sync and quota aggregation
- **Dynamic model sync** - Routing now syncs Codex/Copilot model lists from authenticated accounts with static fallback
- **Test baseline fixes** - `bun test ./test` avoids legacy folders; updated mocks and default settings

</details>

## Features

- **Flow + Account Routing** - Custom flows for non-official models, account chains for provider-native model IDs
- **Six Providers** - Antigravity, Codex, GitHub Copilot, Zed hosted models, Kiro, and Grok
- **Remote Access** - ngrok/cloudflared/localtunnel with one-click setup
- **Full Dashboard** - Quota monitoring, routing config, settings panel
- **Cooldown-aware failover** - Cooldown-aware selection among authorized accounts after quota, auth, or transient upstream failures
- **Dual Format** - OpenAI and Anthropic API compatible
- **Tool Calling** - Function calling for Claude Code and CLI tools

### Security boundary

The complete dashboard and management API bind to loopback by default. Remote access uses a separate inference-only listener (default `8966`) and requires `ANTI_API_PUBLIC_TOKEN`; tunnels never expose credentials, logs, settings, account management, or the updater. Credential imports are explicit by default and create local copies under `~/.anti-api`.

## Zed Account Notes

- **Import model** - Anti-API reads the currently signed-in `Zed.app` account from macOS Keychain when you click `Add Account -> Zed`
- **Why it differs from Codex/Copilot** - Zed does not expose multiple local auth files that can be scanned in bulk; the local desktop state is effectively a single current login
- **What multi-account means for Zed here** - You can switch accounts inside Zed and import them one at a time into Anti-API; imported Zed accounts remain stored in Anti-API afterwards
- **What is not supported** - Automatic bulk discovery of many Zed accounts from one machine is not available in the same way as Codex/Copilot
- **Quota monitor behavior** - Zed hosted models share one monthly spend pool across the account. Anti-API currently shows hosted access status and billing period, not exact remaining dollar credits
- **Credit note** - Zed plan credit depends on the plan type. For example, Zed Student is documented by Zed as including $10/month in AI token credits, while standard Pro pages may show different included credit values

## Quick Start

### Linux

```bash
# Install dependencies
bun install

# Start server (default port: 8964)
bun run src/main.ts start
```

### Windows

Double-click `start.bat` to launch.

WinGet packaging is prepared in this repository. After the `winget-pkgs` submission is merged, the install path will be:

```powershell
winget install anti-api
anti-api
```

After installation, `anti-api` starts the service directly in any terminal.

### macOS

Double-click `start.command` to launch.

### Docker

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR, so most users never build locally.

#### Quick start (recommended)

```bash
docker run -d --name anti-api \
  -p 127.0.0.1:8964:8964 -p 127.0.0.1:1455-1465:1455-1465 -p 127.0.0.1:51121-51131:51121-51131 \
  -e ANTI_API_CONTAINER_CONTROL_PLANE=1 \
  -v anti-api-data:/app/data \
  ghcr.io/ink1ing/anti-api:latest
```

Or with Compose (pulls the prebuilt image, then runs in the background):

```bash
docker compose pull
docker compose up -d
```

On **Windows**, run the exact same commands in PowerShell. The named volume `anti-api-data` is managed by Docker, so there is no `$HOME`/path setup to get wrong.

#### First login (once)

The container can't read your local IDE credentials, so sign in via OAuth:

1. Open the dashboard: <http://localhost:8964/quota>
2. Click **Login** for a provider:
   - **GitHub Copilot** — easiest in Docker: enter the shown device code at <https://github.com/login/device>.
   - **Antigravity / Codex** — the panel (and `docker logs anti-api`) prints an `Open this URL to login: ...` link. Open it in your browser; the callback returns to `localhost` and is captured by the mapped ports.
3. When the account appears on the dashboard, point your local client at `http://localhost:8964`. Local placeholder keys are accepted only for client compatibility; remote access requires `ANTI_API_PUBLIC_TOKEN`.

> You can also log in from a terminal: `docker compose exec anti-api bun run src/main.ts add-account`.

#### Ports

| Port range | Purpose |
|---|---|
| `8964` | Loopback control plane + local API |
| `8966` | Optional public inference gateway |
| `51121-51131` | Antigravity OAuth callback |
| `1455-1465` | Codex OAuth callback |

Copilot uses a device-code flow and needs no callback port.

#### Running on a remote host (NAS / VPS)

OAuth callbacks redirect to `localhost`, which won't reach a remote box from your laptop's browser. Either:

- set `ANTI_API_OAUTH_REDIRECT_URL=http://YOUR_HOST:51121/oauth-callback` and open the printed URL, or
- use **Copilot** (device flow, no callback), or
- SSH-forward the ports: `ssh -L 8964:localhost:8964 -L 51121:localhost:51121 user@host`.

The complete control plane is loopback-only by default. For remote inference, expose only the separate public gateway with `ANTI_API_PUBLIC_TOKEN`; do not publish the dashboard, logs, settings, accounts, or updater.

#### Data & migration

Accounts and routing config live in the `anti-api-data` named volume. To **reuse data from a native install**, mount your host folder instead of the named volume in `docker-compose.yml`:

```yaml
    volumes:
      - ${HOME}/.anti-api:/app/data         # macOS / Linux
      # - ${USERPROFILE}/.anti-api:/app/data  # Windows
```

To import host provider credentials (Codex/AWS/Kiro/etc.) read-only, uncomment the example mounts in `docker-compose.yml`.

#### Development (hot reload)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

#### Notes

- Build locally instead of pulling: `docker compose up -d --build` (the image already ships the toolchain for the native `better-sqlite3` module).
- In-panel self-update is disabled in Docker; upgrade with `docker compose pull && docker compose up -d`.
- Restricted networks: `ANTI_API_COPILOT_INSECURE_TLS=1` / `ANTI_API_CODEX_INSECURE_TLS=1` bypass TLS verification (not recommended generally).
- `ANTI_API_CODEX_REASONING_EFFORT=low|medium|high` sets Codex default effort (default `medium`).
- Override the base image if a registry is slow: `BUN_IMAGE=oven/bun:1.3.5 docker compose build`.
- ngrok is bundled for Linux amd64/arm64.

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
│  │  • Account Routing (provider-native model IDs)               │  │
│  │  • Auto-rotation on 429 errors                        │  │
│  │  • Multi-provider support                             │  │
│  └──────────────────────────────────────────────────────┘  │
│                           ▼                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Antigravity  │  │    Codex     │  │   Copilot    │      │
│  │   Provider   │  │   Provider   │  │   Provider   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────┐                                        │
│  │     Zed      │                                        │
│  │   Provider   │                                        │
│  └──────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
                           ▼
              ┌──────────────────────────┐
              │   Upstream Cloud APIs    │
              │ (Google, OpenAI, GitHub, Zed) │
              └──────────────────────────┘
```

## Smart Routing System (Beta)

> **Beta Feature**: Routing is experimental. Configuration may change in future versions.

The routing system is split into two modes:

- **Flow Routing**: Custom model IDs (e.g. `route:fast`) use your flow entries.
- **Account Routing**: Provider-native model IDs (e.g. `claude-sonnet-4-5`) use per-model account chains.

This enables fine-grained control over model-to-account mapping, allowing you to:

- **Load Balance**: Distribute requests across multiple accounts
- **Model Specialization**: Route specific models to dedicated accounts
- **Provider Mixing**: Combine Antigravity, Codex, GitHub Copilot, and Zed in custom flows
- **Fallback Chains**: Automatic failover when primary accounts hit rate limits

### How It Works

```
Request
  ├─ Provider-native model → Account Routing → Account chain → Provider → Upstream API
  └─ Custom model/route:flow → Flow Routing → Flow entries → Provider → Upstream API

No match → 400 error
```

### Configuration

1. **Access Panel**: `http://localhost:8964/routing`
2. **Flow Routing**: Create a flow (e.g., "fast", "opus"), add Provider → Account → Model entries
3. **Account Routing**: Choose a provider-native model, set account order, optionally enable Smart Switch
4. **Use Flow**: Set `model` to `route:<flow-name>` or the flow name directly
5. **Use Provider-native Model**: Request the provider-native model ID directly (e.g., `claude-sonnet-4-5`)

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
- **Authorized cross-device access**: Connect environments administered by the same user or organization through the authenticated inference-only gateway; do not share personal subscriptions or credentials.
- **External Tools**: Connect AI tools that require public URLs

### Supported Tunnels

| Tunnel | Account Required | Stability | Speed |
|--------|------------------|-----------|-------|
| **ngrok** | Provider-dependent | Managed third-party tunnel | Fast setup |
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
| `gemini-3-flash` | Latency-oriented option |
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

> **范围与授权说明**：Anti-API 是独立、非官方的互操作项目。部分集成使用提供商的 CLI、网页或内部端点，可能随时失效。兼容性不代表提供商隶属或背书。仅可使用本人拥有或被明确授权管理的账号与服务，并须遵守各提供商现行条款；不得为维持兼容而停用安全更新或提供商控制。

## 更新内容 (v3.1.0)

- **新增 Grok Provider 支持** - 通过 Grok CLI 的反向代理（`cli-chat-proxy.grok.com`，OpenAI Responses API）接入 xAI Grok，包含账号导入、模型路由与配额体系集成
- **暴露两个 Grok 模型** - 提供的标准 ModelName 是 `grok-build`（面板显示为 **Xbuild**），但其对应的实际模型是 **Grok 4.3**（可在 Grok CLI 内看到）；以及 `grok-composer-2.5-fast`（Composer 2.5 Fast）
- **显式导入凭证** - 用户主动操作后可从现有 Grok CLI 会话导入凭证；不新增独立登录流程。提供商政策、配额和账号处置规则仍然适用。

<details>
<summary>v3.0.0</summary>

- **新增 Kiro Provider 支持** - 加入 Kiro 账号导入、配额展示、模型路由和反向代理能力
- **控制面板国际化** - 增加全局中文支持、默认跟随系统语言，并在设置页提供语言切换
- **账号诊断助手** - 新增仅限本机访问的诊断面板，用于检查账号文件、CLI 工具、回调端口和 provider 配置
- **面板更新能力** - 新增仅限本机访问的检查更新和源码安装一键更新，并对 WinGet、Docker 做保护提示
- **完善 Docker 支持** - 更新 Docker 默认配置、OAuth 端口范围、健康检查、开发 compose 分离和 Docker 更新说明

</details>

<details>
<summary>v2.9.0</summary>

- **稳定的 Homebrew 安装包** - Homebrew 现在直接安装预编译的 macOS Apple Silicon 包，`brew install anti-api` 不再依赖本地下载 Rust、LLVM 或 Bun
- **新增 WinGet 发布链路** - 补齐了 Windows portable 打包、WinGet manifest 生成和 release workflow，为 `winget install anti-api` 做准备
- **统一安装后启动行为** - Homebrew 和 WinGet 安装后的行为统一为：在任意终端输入 `anti-api` 直接启动服务
- **新增便携运行时支持** - Windows portable 入口会自动拉起 Rust proxy，加载打包后的 dashboard 静态文件，并规避包管理器安装下的自更新冲突
- **增强包管理器保护** - Homebrew / WinGet 安装不再自覆盖更新，而是分别提示使用 `brew upgrade anti-api` 和 `winget upgrade anti-api`

</details>

<details>
<summary>v2.8.0</summary>

- **新增 Zed 托管模型支持** - Anti-API 现在可以导入当前 Zed.app 的登录态，并将请求路由到 Zed 提供的模型
- **按账号动态拉取模型** - Routing 会从每个可用的 Codex 和 Copilot 账号实时拉取模型，并加入 Zed 的账号级模型同步
- **明确 Zed 账号边界** - Zed 账号可以逐个导入并保存在 Anti-API 中，但不能像 Codex/Copilot 一样自动批量发现
- **更新 Zed 配额卡片** - Zed 卡片改为展示共享的 all models 支持状态和订阅周期时间，不再用误导性的剩余额度百分比
- **增强 Zed 稳定性** - 为 Zed 的账号读取、模型同步和 completion 请求增加了超时控制与成功后状态恢复

</details>

## 特性

- **Flow + Account 路由** - 自定义流控制非官方模型，官方模型使用账号链
- **五家 Provider** - Antigravity、Codex、GitHub Copilot、Zed 托管模型、Kiro
- **远程访问** - ngrok/cloudflared/localtunnel 一键设置
- **完整面板** - 配额监控、路由配置、设置面板
- **自动轮换** - 429 错误时切换账号
- **双格式支持** - OpenAI 和 Anthropic API 兼容
- **工具调用** - 支持 function calling，兼容 Claude Code

## Zed 账号说明

- **导入方式** - 点击 `Add Account -> Zed` 时，Anti-API 会读取当前 `Zed.app` 在 macOS Keychain 中的登录态
- **为什么和 Codex/Copilot 不同** - Zed 本地没有像 Codex/Copilot 那样可批量扫描的多账号认证文件，桌面端本质上更接近“当前单登录态”
- **这里的多账号含义** - 你可以先在 Zed 内切换账号，再逐个导入到 Anti-API；导入后的 Zed 账号会继续保存在 Anti-API 内
- **当前不支持的能力** - 不能像 Codex/Copilot 一样，直接从一台机器上自动批量发现多个 Zed 本地账号
- **额度监控说明** - Zed 的 hosted models 共用同一个月度消耗池。Anti-API 当前展示的是 hosted access 状态和订阅周期，不是精确的剩余美元额度
- **Credit 说明** - Zed 的月度 credit 取决于具体计划类型。例如 Zed Student 官方说明为每月 $10 AI token credits，而普通 Pro 页面可能显示不同额度

## 快速开始

### Windows

双击 `start.bat` 启动。

仓库内已经补齐 WinGet 打包与 manifest 生成链路。待 `winget-pkgs` 合并后，可直接使用：

```powershell
winget install anti-api
anti-api
```

安装完成后，在任意终端输入 `anti-api` 会直接启动服务。

### Linux

```bash
# 安装依赖
bun install

# 启动服务（默认端口：8964）
bun run src/main.ts start
```

### macOS

双击 `start.command` 启动。

### Docker

构建：

```bash
docker build -t anti-api .
```

运行：

```bash
docker run --rm -it \\
  -p 8964:8964 \\
  -p 1455-1465:1455-1465 \\
  -p 51121-51131:51121-51131 \\
  -e ANTI_API_DATA_DIR=/app/data \\
  -e ANTI_API_NO_OPEN=1 \\
  -e ANTI_API_OAUTH_NO_OPEN=1 \\
  -e ANTI_API_PACKAGE_MANAGER=docker \\
  -e ANTI_API_NO_SELF_UPDATE=1 \\
  -v $HOME/.anti-api:/app/data \\
  anti-api
```

Compose：

```bash
docker compose up --build
```

开发覆盖模式（不重建，直接使用本地 `src/` 与 `public/`）：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build
```

说明：
- OAuth 回调使用 `51121-51131`（Antigravity）和 `1455-1465`（Codex 浏览器 OAuth），请确保已映射这些端口。
- 如果运行在远程主机，请将 `ANTI_API_OAUTH_REDIRECT_URL` 设置为公网地址，例如 `http://YOUR_HOST:51121/oauth-callback`。
- 挂载 `~/.anti-api` 后，Docker 会复用本地账号和路由配置。
- 本地导入类 provider 默认看不到宿主机凭据；如需导入，请按 `docker-compose.yml` 里的注释示例挂载 `.codex`、`.cli-proxy-api`、`.aws`、Kiro CLI 或 Amazon Q 目录。
- 设置 `ANTI_API_NO_OPEN=1` 可避免容器内尝试自动打开浏览器。
- Docker 内禁用面板自更新，请使用 `docker compose up -d --build` 重建或拉取镜像更新。
- 如果受限网络下 Copilot TLS 失败，可设置 `ANTI_API_COPILOT_INSECURE_TLS=1`（不建议常规使用）。
- 如果受限网络下 Codex TLS 失败，可设置 `ANTI_API_CODEX_INSECURE_TLS=1`（不建议常规使用）。
- 可通过 `ANTI_API_CODEX_REASONING_EFFORT=low|medium|high` 设置 Codex 默认推理强度（默认 `medium`）。
- 如果 Docker Hub 不稳定，默认基础镜像已使用 GHCR；可用 `BUN_IMAGE=oven/bun:1.3.5` 覆盖。
- 镜像内已为 Linux amd64/arm64 安装 ngrok。

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
│  ┌──────────────┐                                        │
│  │     Zed      │                                        │
│  └──────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

## 智能路由系统 (Beta)

> **测试功能**：路由系统为实验性功能，配置格式可能在未来版本中变更。

路由系统拆分为两种模式：

- **Flow 路由**：自定义模型 ID（如 `route:fast`）使用流配置
- **Account 路由**：官方模型 ID（如 `claude-sonnet-4-5`）使用账号链

由此实现模型到账号的精细控制：

- **获授权账号选择** - 在本人拥有或获授权管理的账号之间选择路由
- **模型专用** - 指定模型使用专用账号
- **混合提供商** - 组合 Antigravity、Codex、Copilot、Zed
- **遵守冷却的故障转移** - 在配额、认证或短暂上游失败后，仅在获授权账号中按冷却时间选择

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
**Account 路由**：Smart Switch 仅在获授权账号集合内展开；不会为规避限制创建或聚合账号。

---

## 远程访问

将本地 Anti-API 暴露到公网，支持跨设备访问：

- **移动开发** - iOS/Android 测试 AI 集成
- **获授权的跨设备访问** - 通过带认证、仅提供推理功能的网关连接同一用户或组织管理的环境；不得共享个人订阅或凭证。
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

**安全提示**: 隧道是第三方服务，仅应暴露带 `ANTI_API_PUBLIC_TOKEN` 的推理网关；面板、日志、设置、账号与更新器保持本机访问。

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
| `gemini-3-flash` | 低延迟选项 |
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

### Zed Hosted Models
| 模型 ID | 说明 |
|---------|------|
| 动态拉取 | 按账号从 Zed 实时同步模型列表 |
| 共享 hosted access | 所有托管模型共用同一 hosted 状态/周期 |

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
