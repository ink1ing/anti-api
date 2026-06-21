# Anti-API Development Guide

## Overview
Anti-API proxies Antigravity's internal AI models as an Anthropic-compatible API.

## Key Files

- `src/main.ts` - CLI entry point
- `src/server.ts` - Hono HTTP server setup
- `src/services/antigravity/chat.ts` - Core chat logic
- `src/proto/encoder.ts` - Protobuf encoding with model selection
- `src/lib/port-finder.ts` - Antigravity port discovery

## Model Selection

Models are specified via `model` parameter in requests. See `MODEL_ENUM` in `encoder.ts` for supported values.

## API Compatibility

Supports `/v1/messages`, `/v1beta/messages`, and `/messages` endpoints for maximum compatibility.

## Running

```bash
bun run src/main.ts start       # Default port 8964
bun run src/main.ts start -v    # Verbose logging
```

## Providers

Hosted providers are wired through `src/services/routing/router.ts` (dispatch),
`src/services/routing/models.ts` (model registry) and `src/services/auth`
(account store / types). Current providers: `antigravity`, `codex`, `copilot`,
`zed`, `kiro`, `grok`.

### Grok (xAI)

- Reverse proxy: `https://cli-chat-proxy.grok.com/v1/responses` (OpenAI Responses API).
- Required headers: `x-grok-client-version`, `x-grok-client-identifier`.
- Credentials are imported from the local Grok CLI session (`~/.grok/auth.json`)
  and auto-refreshed — no standalone login flow (reduces account-ban risk).
- Exposed models: `grok-build` (panel label **Xbuild**, maps to the real
  **Grok 4.3** model) and `grok-composer-2.5-fast` (Composer 2.5 Fast).
- Code: `src/services/grok/oauth.ts`, `src/services/grok/chat.ts`.

## Maintenance Notes

- **Secret-scanning alerts for built-in provider OAuth credentials** (e.g.
  `src/services/antigravity/oauth.ts`) are expected. These are public
  "installed application" client credentials shipped inside the upstream client,
  not confidential or personal secrets, and are required for the OAuth flow.
  Resolve such alerts as `wont_fix` — do not rotate or remove them.
