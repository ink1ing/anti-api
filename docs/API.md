# API Reference / API 参考

## Local and Public Access / 本地与公开访问

The complete Anti-API application listens on loopback by default. On this local-only listener, `Authorization` and `x-api-key` may be present solely because compatible clients require those headers; their value is **not** an access-control credential.

Anti-API 完整应用默认只监听回环地址。在这个仅限本机的监听器上，`Authorization` 和 `x-api-key` 可能只是兼容客户端要求的协议占位字段，**不构成**访问控制。

For LAN, reverse-proxy, or tunnel access, configure the separate inference-only gateway:

```bash
export ANTI_API_PUBLIC_TOKEN='replace-with-a-long-random-secret'
export ANTI_API_PUBLIC_PORT=8966
bun run src/main.ts start
```

Public clients must send the configured token in one of these headers:

```http
Authorization: Bearer replace-with-a-long-random-secret
# or
x-api-key: replace-with-a-long-random-secret
```

The public gateway exposes only message/chat completion routes, model-list routes, and a minimal `/health`. It does not expose the dashboard, credentials, quota data, logs, routing/settings, tunnel controls, account deletion, diagnostics, or updater. Query-string tokens are not accepted.

公网网关只暴露消息/聊天补全、模型列表和最小化 `/health`；不会暴露面板、凭证、配额、日志、路由/设置、隧道控制、账号删除、诊断或更新器，也不接受查询参数中的 Token。

---

## OpenAI Compatible API

### POST /v1/chat/completions

**Request Example / 请求示例:**

```bash
curl -X POST http://localhost:8964/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-placeholder" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'
```

**Response / 响应:**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "claude-sonnet-4-5",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

### Streaming / 流式响应

Set `"stream": true` to receive Server-Sent Events:

```bash
curl -X POST http://localhost:8964/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-placeholder" \
  -d '{"model": "claude-sonnet-4-5", "messages": [{"role": "user", "content": "Hi"}], "stream": true}'
```

**Stream Response:**
```
data: {"id":"chatcmpl-abc","choices":[{"delta":{"role":"assistant"}}]}
data: {"id":"chatcmpl-abc","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"chatcmpl-abc","choices":[{"delta":{"content":"!"}}]}
data: {"id":"chatcmpl-abc","choices":[{"finish_reason":"stop"}]}
data: [DONE]
```

---

## Anthropic Compatible API

### POST /v1/messages

**Request Example / 请求示例:**

```bash
curl -X POST http://localhost:8964/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: local-placeholder" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

**Response / 响应:**

```json
{
  "id": "msg_abc123",
  "type": "message",
  "role": "assistant",
  "content": [{
    "type": "text",
    "text": "Hello! How can I help you today?"
  }],
  "model": "claude-sonnet-4-5",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20
  }
}
```

---

## Tool Calling / 工具调用

### OpenAI Format

```bash
curl -X POST http://localhost:8964/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-placeholder" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "City name"}
          },
          "required": ["city"]
        }
      }
    }]
  }'
```

**Tool Call Response:**
```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\": \"Tokyo\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

---

## Error Codes / 错误码

| Status | Description | 描述 |
|--------|-------------|------|
| 200 | Success | 成功 |
| 400 | Bad Request | 请求格式错误 |
| 401 | Unauthorized | 未授权（需要 OAuth 登录）|
| 429 | Rate Limited | 请求过于频繁或配额耗尽 |
| 500 | Server Error | 服务器内部错误 |
| 503 | Upstream Unavailable | 上游服务不可用 |

**Error Response Format:**
```json
{
  "error": {
    "type": "error_type",
    "message": "Error description"
  }
}
```

---

## Models / 支持的模型

| Model ID | Provider | Features |
|----------|----------|----------|
| `claude-sonnet-4-5` | Antigravity | Fast, balanced |
| `claude-sonnet-4-5-thinking` | Antigravity | Extended thinking |
| `claude-opus-4-5-thinking` | Antigravity | Extended reasoning |
| `claude-opus-4-6-thinking` | Antigravity | Extended reasoning (new generation) |
| `gemini-3-flash` | Antigravity | Fast responses |
| `gemini-3-pro-high` | Antigravity | High quality |
| `fast` | Routing | Latency-oriented route |
| `opus` | Routing | Auto-select Opus |

### Using Routing / 使用路由

Prefix model with `route:` to select a custom flow:

```json
{"model": "route:my-custom-flow", "messages": [...]}
```
