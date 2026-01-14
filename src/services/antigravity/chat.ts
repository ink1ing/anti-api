/**
 * Antigravity Chat Service - Cloud API Version
 * v2.1.0
 */

import consola from "consola"
import { getAccessToken } from "./oauth"
import { accountManager } from "./account-manager"
import { state } from "~/lib/state"
import { type ClaudeMessage, type ClaudeTool } from "~/lib/translator"
import { rateLimiter } from "~/lib/rate-limiter"
import { determineRetryStrategy, applyRetryDelay } from "~/lib/retry"
import { UpstreamError } from "~/lib/error"
import { cleanJsonSchemaForGemini } from "~/lib/json-schema-cleaner"

accountManager.load()

const ANTIGRAVITY_BASE_URLS = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
]
const STREAM_ENDPOINT = "/v1internal:streamGenerateContent"
const DEFAULT_USER_AGENT = "antigravity/1.11.9 windows/amd64"
const MAX_RETRY_ATTEMPTS = 5

const MODEL_MAPPING: Record<string, string> = {
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
    "claude-opus-4-5-thinking": "claude-opus-4-5-thinking",
    "claude-sonnet-4-5-20251001": "claude-sonnet-4-5",
    "gemini-3-pro-high": "gemini-3-pro-high",
    "gemini-3-pro-low": "gemini-3-pro-low",
    "gemini-3-flash": "gemini-3-flash",
    "gpt-oss-120b": "gpt-oss-120b-medium",
}

function getAntigravityModelName(userModel: string): string {
    return MODEL_MAPPING[userModel] || userModel
}

export interface ChatRequest {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    maxTokens?: number
}

export interface ContentBlock {
    type: "text" | "tool_use"
    text?: string
    id?: string
    name?: string
    input?: any
}

export interface ChatResponse {
    contentBlocks: ContentBlock[]
    stopReason: string | null
    usage?: { inputTokens: number; outputTokens: number }
}

function generateStableSessionId(messages: ClaudeMessage[]): string {
    const userMsg = messages.find(m => m.role === "user")
    if (userMsg && typeof userMsg.content === "string") {
        let hash = 0
        for (let i = 0; i < userMsg.content.length; i++) {
            hash = ((hash << 5) - hash) + userMsg.content.charCodeAt(i)
            hash = hash & hash
        }
        return "-" + (Math.abs(hash) * 1000000000000).toString()
    }
    return "-" + Math.floor(Math.random() * 9e18).toString()
}

function extractTextContent(content: any): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
        const parts: string[] = []
        for (const block of content) {
            if (block.type === "text" && block.text) parts.push(block.text)
            else if (block.type === "tool_use") parts.push("[Tool: " + block.name + "]")
            else if (block.type === "tool_result" && typeof block.content === "string") parts.push(block.content)
        }
        return parts.join("\n") || "[No text]"
    }
    if (content?.text) return content.text
    return JSON.stringify(content)
}

function cleanJsonSchema(schema: any): any {
    if (!schema || typeof schema !== "object") return schema
    const result: any = {}
    for (const [key, value] of Object.entries(schema)) {
        if (key.startsWith("\$") || key === "additionalProperties") continue
        if (typeof value === "object") result[key] = cleanJsonSchema(value)
        else result[key] = value
    }
    return result
}

function normalizeToolParameters(schema: unknown): any {
    if (!schema) {
        return { type: "object", properties: {} }
    }

    let normalized: any = schema
    if (typeof schema === "string") {
        const trimmed = schema.trim()
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                normalized = JSON.parse(trimmed)
            } catch {
                return { type: "object", properties: {} }
            }
        } else {
            return { type: "object", properties: {} }
        }
    }

    if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
        return { type: "object", properties: {} }
    }

    normalized = cleanJsonSchemaForGemini(normalized)
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
        return { type: "object", properties: {} }
    }

    if (normalized.type !== "object") {
        normalized.type = "object"
    }
    if (!normalized.properties || typeof normalized.properties !== "object" || Array.isArray(normalized.properties)) {
        normalized.properties = {}
    }
    if (normalized.required && !Array.isArray(normalized.required)) {
        delete normalized.required
    }

    return normalized
}

function buildSafetySettings(): any[] {
    return [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
    ]
}

function buildSystemInstruction(): any {
    const antigravityIdentity = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**`

    return {
        role: "user",
        parts: [
            { text: antigravityIdentity },
            { text: "\n--- [SYSTEM_PROMPT_END] ---" }
        ]
    }
}

function claudeToAntigravity(model: string, messages: ClaudeMessage[], tools?: ClaudeTool[]): any {
    const contents = messages.map((msg) => ({
        role: msg.role === "assistant" ? "model" : msg.role,
        parts: [{ text: extractTextContent(msg.content) }],
    }))

    const sessionId = generateStableSessionId(messages)
    const projectId = state.cloudaicompanionProject || "unknown"

    const innerRequest: any = {
        contents,
        sessionId,
        safetySettings: buildSafetySettings(),
        systemInstruction: buildSystemInstruction(),
        generationConfig: {
            maxOutputTokens: 64000,
            stopSequences: ["\n\nHuman:", "[DONE]"],
        },
    }

    if (model.includes("claude")) {
        innerRequest.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } }
    }

    if (tools && tools.length > 0 && model.includes("claude")) {
        innerRequest.tools = tools.map(tool => ({
            functionDeclarations: [{
                name: tool.name,
                description: tool.description,
                parameters: normalizeToolParameters(tool.input_schema)
            }]
        }))
    }

    return {
        model,
        userAgent: "antigravity",
        requestType: "agent",
        project: projectId,
        requestId: "agent-" + crypto.randomUUID(),
        request: innerRequest,
    }
}

function parseApiResponse(rawResponse: string): ChatResponse {
    let chunks: any[] = []
    const trimmed = rawResponse.trim()
    if (trimmed.startsWith("[")) chunks = JSON.parse(trimmed)
    else if (trimmed.startsWith("{")) chunks = [JSON.parse(trimmed)]
    if (chunks.length === 0) throw new Error("Empty response")

    const lastChunk = chunks[chunks.length - 1]
    if (!lastChunk?.response) throw new Error("No valid response")

    const contentBlocks: ContentBlock[] = []
    let hasToolUse = false

    for (const chunk of chunks) {
        const parts = chunk.response?.candidates?.[0]?.content?.parts || []
        for (const part of parts) {
            if (part.text) {
                const last = contentBlocks[contentBlocks.length - 1]
                if (last?.type === "text") last.text = (last.text || "") + part.text
                else contentBlocks.push({ type: "text", text: part.text })
            }
            if (part.functionCall) {
                hasToolUse = true
                contentBlocks.push({
                    type: "tool_use",
                    id: part.functionCall.id || "toolu_" + crypto.randomUUID().slice(0, 8),
                    name: part.functionCall.name,
                    input: part.functionCall.args || {}
                })
            }
        }
    }

    if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" })

    const usage = lastChunk.response.usageMetadata || lastChunk.usageMetadata
    return {
        contentBlocks,
        stopReason: hasToolUse ? "tool_use" : "end_turn",
        usage: { inputTokens: usage?.promptTokenCount || 0, outputTokens: (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0) },
    }
}

function shouldTryNextEndpoint(statusCode: number): boolean {
    return statusCode === 429 || statusCode === 408 || statusCode === 404 || statusCode >= 500
}

async function sendRequestSse(
    endpoint: string,
    antigravityRequest: any,
    accessToken: string,
    accountId?: string,
    allowRotation: boolean = true
): Promise<string> {
    consola.info("Request body:", JSON.stringify(antigravityRequest, null, 2).substring(0, 500))

    let lastError: Error | null = null
    let lastStatusCode = 0
    let lastErrorText = ""
    let lastRetryAfterHeader: string | undefined
    let currentAccessToken = accessToken
    let currentAccountId = accountId

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        // 锁已在 handler.ts HTTP 层获取，这里不需要
        for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
            const url = baseUrl + endpoint + "?alt=sse"
            consola.debug("[SSE] Trying:", url)
            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + currentAccessToken,
                        "User-Agent": DEFAULT_USER_AGENT,
                        "Accept": "text/event-stream",
                    },
                    body: JSON.stringify(antigravityRequest),
                })

                if (response.ok) {
                    consola.success("SSE API successful on:", baseUrl)
                    if (currentAccountId) accountManager.markSuccess(currentAccountId)
                    return await response.text()
                }

                lastStatusCode = response.status
                lastRetryAfterHeader = response.headers.get("retry-after") || undefined
                lastErrorText = await response.text()
                consola.warn("SSE error " + response.status, lastErrorText.substring(0, 200))

                if (lastStatusCode === 429 && currentAccountId) {
                    accountManager.markRateLimitedFromError(
                        currentAccountId,
                        lastStatusCode,
                        lastErrorText,
                        lastRetryAfterHeader
                    )
                    if (allowRotation && accountManager.count() > 1) {
                        const next = await accountManager.getNextAvailableAccount(true)
                        if (next && next.accountId !== currentAccountId) {
                            currentAccessToken = next.accessToken
                            currentAccountId = next.accountId
                            antigravityRequest.project = next.projectId
                            continue
                        }
                    }
                }

                if (shouldTryNextEndpoint(lastStatusCode)) {
                    lastError = new Error("SSE API error: " + response.status)
                    continue
                }

                throw new UpstreamError("antigravity", response.status, lastErrorText, lastRetryAfterHeader)
            } catch (e) {
                if (e instanceof UpstreamError) throw e
                lastError = e as Error
                continue
            }
        }

        if (lastStatusCode > 0) {
            const strategy = determineRetryStrategy(lastStatusCode, lastErrorText, lastRetryAfterHeader)
            await applyRetryDelay(strategy, attempt)
            if (attempt < MAX_RETRY_ATTEMPTS - 1) continue
        }
        break
    }
    if (lastStatusCode > 0) {
        throw new UpstreamError("antigravity", lastStatusCode, lastErrorText, lastRetryAfterHeader)
    }
    throw lastError || new Error("All endpoints failed")
}

function collectSseChunks(rawSse: string): any[] {
    const chunks: any[] = []

    // 🔧 更健壮的解析：按行处理，直接找 data: 开头的行
    const lines = rawSse.split(/\r?\n/)

    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data: ")) continue

        const jsonStr = trimmed.slice(6).trim()
        if (!jsonStr || jsonStr === "[DONE]") continue

        try {
            const parsed = JSON.parse(jsonStr)
            chunks.push(parsed)
        } catch (e) {
            // 忽略解析失败的行
            consola.debug(`[SSE] Failed to parse line: ${jsonStr.substring(0, 100)}`)
        }
    }

    return chunks
}

export async function createChatCompletion(request: ChatRequest): Promise<ChatResponse> {
    return createChatCompletionWithOptions(request)
}

export async function createChatCompletionWithOptions(
    request: ChatRequest,
    options: { accountId?: string; allowRotation?: boolean } = {}
): Promise<ChatResponse> {
    let accessToken: string
    let accountId: string | undefined
    let projectId: string | undefined

    if (options.accountId) {
        const account = await accountManager.getAccountById(options.accountId)
        if (!account) {
            throw new Error(`Account not found: ${options.accountId}`)
        }
        accessToken = account.accessToken
        accountId = account.accountId
        projectId = account.projectId
        consola.debug("Using account:", account.email)
    } else {
        const account = await accountManager.getNextAvailableAccount()
        if (account) {
            accessToken = account.accessToken
            accountId = account.accountId
            projectId = account.projectId
            consola.debug("Using account:", account.email)
        } else {
            accessToken = await getAccessToken()
            projectId = state.cloudaicompanionProject || undefined
        }
    }

    const antigravityRequest = claudeToAntigravity(
        getAntigravityModelName(request.model),
        request.messages,
        request.tools
    )

    if (projectId) antigravityRequest.project = projectId

    const rawSse = await sendRequestSse(
        STREAM_ENDPOINT,
        antigravityRequest,
        accessToken,
        accountId,
        options.allowRotation ?? true
    )
    const sseChunks = collectSseChunks(rawSse)
    const rawResponse = sseChunks.length > 0 ? JSON.stringify(sseChunks) : rawSse

    return parseApiResponse(rawResponse)
}

export async function* createChatCompletionStream(request: ChatRequest): AsyncGenerator<string, void, unknown> {
    yield* createChatCompletionStreamWithOptions(request)
}

export async function* createChatCompletionStreamWithOptions(
    request: ChatRequest,
    options: { accountId?: string; allowRotation?: boolean } = {}
): AsyncGenerator<string, void, unknown> {
    let accessToken: string
    let accountId: string | undefined
    let projectId: string | undefined

    if (options.accountId) {
        const account = await accountManager.getAccountById(options.accountId)
        if (!account) {
            throw new Error(`Account not found: ${options.accountId}`)
        }
        accessToken = account.accessToken
        accountId = account.accountId
        projectId = account.projectId
    } else {
        const account = await accountManager.getNextAvailableAccount()
        if (account) {
            accessToken = account.accessToken
            accountId = account.accountId
            projectId = account.projectId
        } else {
            accessToken = await getAccessToken()
            projectId = state.cloudaicompanionProject || undefined
        }
    }

    const antigravityRequest = claudeToAntigravity(
        getAntigravityModelName(request.model),
        request.messages,
        request.tools
    )

    if (projectId) antigravityRequest.project = projectId

    const rawResponse = await sendRequestSse(
        STREAM_ENDPOINT,
        antigravityRequest,
        accessToken,
        accountId,
        options.allowRotation ?? true
    )

    // 🔍 Debug: log raw response length and first 200 chars
    consola.debug(`[Stream] Raw response length: ${rawResponse.length}, preview: ${rawResponse.substring(0, 200)}`)

    const chunks = collectSseChunks(rawResponse)

    // 🔍 Debug: log chunks count
    consola.debug(`[Stream] Parsed ${chunks.length} chunks from SSE response`)

    if (chunks.length === 0) {
        consola.warn(`[Stream] No chunks parsed from response. Raw response: ${rawResponse.substring(0, 500)}`)
        throw new Error("Empty SSE response - no chunks parsed")
    }

    let hasFirstResponse = false
    let blockIndex = 0
    let hasToolUse = false
    let outputTokens = 0
    let textBlockStarted = false  // 🔧 跟踪文本块是否已开始

    for (const chunk of chunks) {
        const parts = chunk.response?.candidates?.[0]?.content?.parts || []

        if (!hasFirstResponse) {
            const messageStart = {
                type: "message_start",
                message: {
                    id: "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: request.model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            }
            yield "event: message_start\ndata: " + JSON.stringify(messageStart) + "\n\n"
            hasFirstResponse = true
        }

        for (const part of parts) {
            if (part.text) {
                // 🔧 只在第一次遇到文本时发送 block_start
                if (!textBlockStarted) {
                    yield "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":" + blockIndex + ",\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
                    textBlockStarted = true
                }
                // 每个 text chunk 只发送 delta
                const textDelta = { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: part.text } }
                yield "event: content_block_delta\ndata: " + JSON.stringify(textDelta) + "\n\n"
            }
            if (part.functionCall) {
                // 先关闭文本块（如果有）
                if (textBlockStarted) {
                    yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":" + blockIndex + "}\n\n"
                    blockIndex++
                    textBlockStarted = false
                }

                hasToolUse = true
                const toolStart = { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: part.functionCall.id || "toolu_" + Date.now(), name: part.functionCall.name, input: {} } }
                yield "event: content_block_start\ndata: " + JSON.stringify(toolStart) + "\n\n"
                if (part.functionCall.args) {
                    const inputDelta = { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(part.functionCall.args) } }
                    yield "event: content_block_delta\ndata: " + JSON.stringify(inputDelta) + "\n\n"
                }
                yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":" + blockIndex + "}\n\n"
                blockIndex++
            }
        }

        const usage = chunk.response?.usageMetadata
        if (usage) outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
    }

    // 🔧 关闭最后的文本块（如果有）
    if (textBlockStarted) {
        yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":" + blockIndex + "}\n\n"
    }

    const stopReason = hasToolUse ? "tool_use" : "end_turn"
    const messageDelta = { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }
    yield "event: message_delta\ndata: " + JSON.stringify(messageDelta) + "\n\n"
    yield "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
}
