# Anti-API

<p align="center">
  <strong>Expose Antigravity's built-in AI models as an Anthropic-compatible API</strong>
</p>

<p align="center">
  A local proxy that bridges Antigravity's internal LLM capabilities to Claude Code and other Anthropic-compatible tools.
</p>

## Features

- 🚀 **Full Model Support** - Access Claude 4.5, Gemini 3, GPT-OSS 120B and more
- 🔌 **Anthropic API Compatible** - Works with Claude Code and other tools
- 🎯 **Model Selection** - Choose your preferred model via API
- 🔒 **Local Only** - All requests stay on your machine
- ⚡ **Fast Setup** - One-click start with `start.command`

## Requirements

- [Antigravity](https://antigravity.dev) installed and logged in
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
| `claude-sonnet-4-5` | Claude Sonnet 4.5 |
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 (Thinking) |
| `claude-haiku-4-5` | Claude Haiku 4.5 |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 (Thinking) |

### Gemini
| Model | Description |
|-------|-------------|
| `gemini-3-pro-high` | Gemini 3 Pro (High) |
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
