# Routing + Multi-Auth Plan (Anthropic Only)

## Goals

- Add multi-provider authentication for Antigravity, Codex, and GitHub Copilot.
- Provide a routing workflow editor (`/routing`) with drag-and-drop fallback chain.
- Execute Anthropic-compatible requests via the configured chain and respect cooldown/Retry-After before selecting another eligible authorized account.
- Keep credentials persistent, structured, and maintainable.

## Architecture

### Credential Storage

- Location: `~/.anti-api/auth/`
- File schema (JSON):
  - `type`: `antigravity` | `codex` | `github-copilot`
  - `id`, `email`, `login`, `label`
  - `access_token`, `refresh_token`, `expires_at`
  - `project_id`, `created_at`, `updated_at`

### Routing Config

- Location: `~/.anti-api/routing.json`
- Each entry:
  - `provider`, `accountId`, `modelId` (actual), `label` (front-end alias)
  - Optional `accountLabel` for UI display

### Anthropic Request Flow

- `/v1/messages` -> `createRoutedCompletion` / `createRoutedCompletionStream`
- Chain order respects `/routing` configuration.
- 429 records a cooldown; another eligible entry may be selected only within the operator's authorized account set.
- Antigravity entries can be pinned to a specific account (no internal rotation).

## Endpoints

- `GET /routing` -> routing UI
- `GET /routing/config` -> current config + account list + model list
- `POST /routing/config` -> save entries

- `POST /auth/login` -> provider auth (`antigravity` | `codex` | `copilot`)
- `GET /auth/accounts` -> summary for UI
- `GET /auth/copilot/status` -> device flow polling

## UI

- `/quota`: add `Routing` button + `Add Account` modal.
- `/routing`: flow graph editor (n8n/comfyui style) with drag-and-drop nodes.

## Env Requirements

- `COPILOT_CLIENT_ID` for GitHub device code flow.
- `CODEX_CLIENT_SECRET` for Codex OAuth exchange.

## Limitations

- Only Anthropic-compatible API (`/v1/messages`) is routed.
- OpenAI-compatible endpoint remains Antigravity-only (for now).
