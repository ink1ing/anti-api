import consola from "consola"
import https from "https"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import { importCodexAuthSources, refreshCodexAccountIfNeeded, refreshCodexAccessToken } from "~/services/codex/oauth"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"

// Disable TLS certificate verification for ChatGPT backend API
// ChatGPT.com sometimes has certificate issues with certain network configurations
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"
const CHAT_COMPLETIONS_PATH = "/chat/completions"
const RESPONSES_PATH = "/responses"
const DEFAULT_FALLBACK_MODEL = process.env.CODEX_FALLBACK_MODEL || "gpt-5"
const CODEX_MAX_RETRIES = 2
const CODEX_RETRY_BASE_MS = 600
const CODEX_RETRY_JITTER_MS = 300
const CODEX_RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 521, 522, 524])

// Codex-specific headers matching CLIProxyAPI
function getCodexHeaders(accessToken: string, accountId?: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "text/event-stream",
        "Connection": "Keep-Alive",
        "Openai-Beta": "responses=experimental",
        "User-Agent": "codex_cli_rs/0.50.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
        "Originator": "codex_cli_rs",
        "Version": "0.21.0",
        ...(accountId ? { "Chatgpt-Account-Id": accountId } : {}),
    }
}

type InsecureResponse = {
    status: number
    data: any
    text: string
}

type FetchOptions = {
    method?: string
    headers?: Record<string, string>
    body?: string
}

function getErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined
    const direct = (error as { code?: string }).code
    const cause = (error as { cause?: { code?: string } }).cause
    return direct || cause?.code
}

function getErrorMessage(error: unknown): string {
    if (!error || typeof error !== "object") return ""
    const direct = (error as { message?: string }).message
    const cause = (error as { cause?: { message?: string } }).cause
    return String(direct || cause?.message || "")
}

function isCertificateError(error: unknown): boolean {
    const code = getErrorCode(error)
    if (code === "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR") return true
    if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return true
    if (code === "SELF_SIGNED_CERT_IN_CHAIN") return true
    if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return true
    if (code === "CERT_HAS_EXPIRED") return true
    const message = getErrorMessage(error).toLowerCase()
    if (message.includes("certificate") || message.includes("self signed")) return true
    if (message.includes("unable to verify") || message.includes("ssl") || message.includes("tls")) return true
    const fallback = String(error).toLowerCase()
    return fallback.includes("certificate") || fallback.includes("self signed") || fallback.includes("unable to verify")
}

function shouldRetryInsecure(error: unknown): boolean {
    if (isCertificateError(error)) return true
    const message = getErrorMessage(error).toLowerCase()
    if (message.includes("fetch failed") || message.includes("network") || message.includes("connection")) return true
    if (message.includes("timeout") || message.includes("timed out") || message.includes("econnreset")) return true
    const fallback = String(error).toLowerCase()
    return fallback.includes("fetch failed") || fallback.includes("network") || fallback.includes("connection")
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function getRetryDelay(attempt: number): number {
    const jitter = Math.floor(Math.random() * CODEX_RETRY_JITTER_MS)
    return CODEX_RETRY_BASE_MS * Math.pow(2, attempt) + jitter
}

function isRetryableStatus(status: number): boolean {
    return CODEX_RETRY_STATUSES.has(status)
}

async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<InsecureResponse> {
    const bunFetch = (globalThis as { Bun?: { fetch?: typeof fetch } }).Bun?.fetch
    if (bunFetch) {
        const response = await bunFetch(url, {
            method: options.method,
            headers: options.headers,
            body: options.body,
            tls: { rejectUnauthorized: false },
        })
        const text = await response.text()
        let data: any = null
        if (text) {
            try {
                data = JSON.parse(text)
            } catch {
                data = null
            }
        }
        return { status: response.status, data, text }
    }

    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api",
        ...(options.headers || {}),
    }
    const insecureAgent = new https.Agent({ rejectUnauthorized: false })

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers,
                agent: insecureAgent,
                rejectUnauthorized: false,
                timeout: 10000,
            },
            (res) => {
                let body = ""
                res.on("data", (chunk) => {
                    body += chunk
                })
                res.on("end", () => {
                    let data: any = null
                    if (body) {
                        try {
                            data = JSON.parse(body)
                        } catch {
                            data = null
                        }
                    }
                    resolve({
                        status: res.statusCode || 0,
                        data,
                        text: body,
                    })
                })
            }
        )

        req.on("error", reject)
        req.on("timeout", () => {
            req.destroy(new Error("Request timed out"))
        })

        if (options.body) {
            req.write(options.body)
        }
        req.end()
    })
}

async function fetchWithOptionalTls(url: string, options: FetchOptions) {
    const bunFetch = (globalThis as { Bun?: { fetch?: typeof fetch } }).Bun?.fetch
    if (bunFetch) {
        // Always disable TLS verification for ChatGPT backend to avoid certificate errors
        const isChatGPT = url.includes("chatgpt.com")
        const tls = (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || isChatGPT)
            ? { rejectUnauthorized: false }
            : undefined
        return bunFetch(url, {
            method: options.method,
            headers: options.headers,
            body: options.body,
            ...(tls ? { tls } : {}),
        })
    }
    return fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
    })
}

interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

// Parse SSE stream response from ChatGPT backend API
// Extracts the response.completed event data matching CLIProxyAPI's approach
function parseCodexSSEResponse(sseText: string): any {
    const lines = sseText.split("\n")
    const textChunks: string[] = []
    let lastResponse: any = null
    for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        try {
            const parsed = JSON.parse(data)
            if (parsed.type === "response.completed") {
                return parsed.response || parsed
            }
            if (parsed.type === "response.created" && parsed.response) {
                lastResponse = parsed.response
            }
            if (typeof parsed?.delta === "string" && String(parsed.type || "").includes("output_text")) {
                textChunks.push(parsed.delta)
            } else if (typeof parsed?.text === "string" && String(parsed.type || "").includes("output_text")) {
                textChunks.push(parsed.text)
            } else if (typeof parsed?.output_text === "string") {
                textChunks.push(parsed.output_text)
            }
        } catch {
            // Skip invalid JSON lines
        }
    }
    if (textChunks.length > 0) {
        const output = [{
            type: "message",
            content: [{ type: "output_text", text: textChunks.join("") }]
        }]
        return lastResponse ? { ...lastResponse, output } : { output }
    }
    // If no response.completed found, try to find any output content
    for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        try {
            const parsed = JSON.parse(data)
            if (parsed.output || parsed.choices) {
                return parsed
            }
        } catch {
            // Skip invalid JSON lines
        }
    }
    if (lastResponse) {
        return { ...lastResponse, output: [] }
    }
    // Log the raw SSE for debugging
    consola.error("Codex SSE parse failed. Raw SSE (first 1000 chars):", sseText.slice(0, 1000))
    throw new Error("No valid response found in SSE stream")
}

function shouldFallbackModel(model: string, error: UpstreamError): boolean {
    // Disable fallback for ChatGPT backend - models like gpt-4.1 are not supported
    // Let the error propagate instead of trying unsupported fallback models
    return false
}

function shouldUseResponses(model: string): boolean {
    // ChatGPT backend only supports /responses endpoint, use it for all models
    return true
}

function isAuthStatus(error: UpstreamError): boolean {
    return error.status === 401 || error.status === 403
}

function isRefreshTokenReuseError(error: unknown): boolean {
    const message = String((error as { message?: string })?.message || error || "").toLowerCase()
    return message.includes("refresh token") && message.includes("already been used")
}

function isEmptyCompletion(completion: OpenAIResponse): boolean {
    const choice = completion.choices?.[0]
    if (!choice) return true
    const content = choice.message?.content
    const toolCalls = choice.message?.tool_calls || []
    const hasText = typeof content === "string" && content.length > 0
    return !hasText && toolCalls.length === 0
}

function buildCompletionFromResponses(payload: any): OpenAIResponse {
    const output = Array.isArray(payload?.output) ? payload.output : []
    // Debug log for diagnosing tool call issues
    if (output.length === 0) {
    }
    const textParts: string[] = []
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []

    for (const item of output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
            for (const content of item.content) {
                if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") {
                    textParts.push(content.text)
                }
                if (content?.type === "tool_call") {
                    toolCalls.push({
                        id: content.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                        type: "function",
                        function: {
                            name: content.name || "tool",
                            arguments: typeof content.arguments === "string"
                                ? content.arguments
                                : JSON.stringify(content.arguments || {}),
                        },
                    })
                }
            }
        } else if (item?.type === "tool_call") {
            toolCalls.push({
                id: item.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string"
                        ? item.arguments
                        : JSON.stringify(item.arguments || {}),
                },
            })
        } else if (item?.type === "function_call") {
            // ChatGPT Responses API uses function_call with call_id (not id)
            toolCalls.push({
                id: item.call_id || item.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string"
                        ? item.arguments
                        : JSON.stringify(item.arguments || {}),
                },
            })
        } else if (item?.type === "output_text" && typeof item.text === "string") {
            textParts.push(item.text)
        }
    }

    if (textParts.length === 0 && typeof payload?.output_text === "string") {
        textParts.push(payload.output_text)
    }

    return {
        choices: [
            {
                message: {
                    content: textParts.join(""),
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                },
                finish_reason: payload?.stop_reason || null,
            },
        ],
        usage: {
            prompt_tokens: payload?.usage?.input_tokens || 0,
            completion_tokens: payload?.usage?.output_tokens || 0,
        },
    }
}

// Convert OpenAI Chat messages to Codex Responses API input format
// Key differences from Chat Completions API:
// - Messages use type: "message" with content as array of {type: "input_text", text: "..."}
// - Assistant tool_calls become separate {type: "function_call", call_id, name, arguments} objects
// - Tool results become {type: "function_call_output", call_id, output} objects
function toCodexResponsesInput(messages: ReturnType<typeof toOpenAIMessages>): any[] {
    const input: any[] = []

    for (const msg of messages) {
        if (msg.role === "user") {
            input.push({
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: msg.content || "" }]
            })
        } else if (msg.role === "assistant") {
            // Add message content (without tool_calls, as they go separately)
            input.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: msg.content || "" }]
            })

            // Convert tool_calls to separate function_call objects
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    input.push({
                        type: "function_call",
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments
                    })
                }
            }
        } else if (msg.role === "tool") {
            // Tool results become function_call_output objects
            input.push({
                type: "function_call_output",
                call_id: msg.tool_call_id,
                output: msg.content || ""
            })
        } else if (msg.role === "system") {
            // System messages are handled as instructions, skip in input
            continue
        }
    }

    return input
}

async function requestChatCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
): Promise<{ completion: OpenAIResponse; model: string }> {
    const requestBody = {
        model,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
    }
    const url = `${CODEX_API_BASE}${CHAT_COMPLETIONS_PATH}`
    const headers = getCodexHeaders(account.accessToken, account.id)

    let lastError: unknown
    for (let attempt = 0; attempt <= CODEX_MAX_RETRIES; attempt++) {
        try {
            const response = await fetchWithOptionalTls(url, {
                method: "POST",
                headers,
                body: JSON.stringify(requestBody),
            })

            if (!response.ok) {
                const errorText = await response.text()
                const retryAfter = response.headers.get("retry-after") || undefined
                if (isRetryableStatus(response.status) && attempt < CODEX_MAX_RETRIES) {
                    await sleep(getRetryDelay(attempt))
                    continue
                }
                throw new UpstreamError("codex", response.status, errorText, retryAfter)
            }

            const data = await response.json() as OpenAIResponse
            return { completion: data, model }
        } catch (error) {
            lastError = error
            if (shouldRetryInsecure(error)) {
                if (isCertificateError(error)) {
                    consola.warn("Codex TLS error detected, retrying with insecure agent")
                } else {
                    consola.warn("Codex request failed, retrying with insecure agent")
                }
                const insecure = await fetchInsecureJson(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(requestBody),
                })
                if (insecure.status < 200 || insecure.status >= 300) {
                    if (isRetryableStatus(insecure.status) && attempt < CODEX_MAX_RETRIES) {
                        await sleep(getRetryDelay(attempt))
                        continue
                    }
                    throw new UpstreamError("codex", insecure.status, insecure.text)
                }
                const data = insecure.data as OpenAIResponse | null
                if (!data) {
                    throw new UpstreamError("codex", insecure.status, insecure.text || "Empty response")
                }
                return { completion: data, model }
            }
            if (attempt < CODEX_MAX_RETRIES) {
                await sleep(getRetryDelay(attempt))
                continue
            }
            throw error
        }
    }
    throw lastError || new UpstreamError("codex", 500, "Codex request failed")
}

async function requestResponsesCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
): Promise<{ completion: OpenAIResponse; model: string }> {
    // CLIProxyAPI format: Codex Responses API requires specific fields
    // Extract system message as instructions, or use default
    const systemMessage = messages.find(m => (m.role as string) === "system")
    const instructions = systemMessage?.content
        ? (typeof systemMessage.content === "string" ? systemMessage.content : "You are a helpful assistant.")
        : "You are a helpful assistant. Please respond to the user's query."

    // Convert tools to ChatGPT Responses API format (flat, not nested)
    // OpenAI format: {type: "function", function: {name, description, parameters}}
    // Responses API format: {type: "function", name, description, parameters}
    const openAITools = toOpenAITools(tools)
    const responsesTools = openAITools?.map(t => ({
        type: "function" as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }))

    const requestBody = {
        model,
        input: toCodexResponsesInput(toOpenAIMessages(messages)),
        tools: responsesTools,
        instructions,
        stream: true,
        store: false,
        parallel_tool_calls: true,
        "reasoning": { "effort": "medium", "summary": "auto" },
        include: ["reasoning.encrypted_content"],
    }
    const url = `${CODEX_API_BASE}${RESPONSES_PATH}`
    const headers = getCodexHeaders(account.accessToken, account.id)

    let lastError: unknown
    for (let attempt = 0; attempt <= CODEX_MAX_RETRIES; attempt++) {
        // Always use insecure fetch for ChatGPT backend to avoid certificate errors
        const insecure = await fetchInsecureJson(url, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
        })

        if (insecure.status < 200 || insecure.status >= 300) {
            lastError = new UpstreamError("codex", insecure.status, insecure.text)
            if (isRetryableStatus(insecure.status) && attempt < CODEX_MAX_RETRIES) {
                await sleep(getRetryDelay(attempt))
                continue
            }
            consola.error(`Codex error ${insecure.status}:`, insecure.text.slice(0, 500))
            throw lastError
        }

        // Parse SSE response (ChatGPT backend returns SSE stream format)
        const data = parseCodexSSEResponse(insecure.text)
        return { completion: buildCompletionFromResponses(data), model }
    }

    throw lastError || new UpstreamError("codex", 500, "Codex request failed")
}

export async function createCodexCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
) {
    const effectiveAccount = await refreshCodexAccountIfNeeded(account)

    let completion: OpenAIResponse | undefined
    let resolvedModel = model
    let refreshedOnce = false
    let lastError: unknown

    const attempt = async (targetModel: string): Promise<OpenAIResponse> => {
        if (shouldUseResponses(targetModel)) {
            const result = await requestResponsesCompletion(effectiveAccount, targetModel, messages, tools, maxTokens)
            return result.completion
        }
        const result = await requestChatCompletion(effectiveAccount, targetModel, messages, tools, maxTokens)
        return result.completion
    }

    try {
        completion = await attempt(model)
    } catch (error) {
        lastError = error
        if (error instanceof UpstreamError && isAuthStatus(error) && effectiveAccount.refreshToken && !refreshedOnce) {
            refreshedOnce = true
            try {
                const imported = await importCodexAuthSources()
                const updated = imported.accounts.find(acc =>
                    acc.id === effectiveAccount.id ||
                    (acc.email && acc.email === effectiveAccount.email)
                )
                if (updated?.accessToken && updated.accessToken !== effectiveAccount.accessToken) {
                    effectiveAccount.accessToken = updated.accessToken
                    if (updated.refreshToken) {
                        effectiveAccount.refreshToken = updated.refreshToken
                    }
                    if (updated.expiresAt) {
                        effectiveAccount.expiresAt = updated.expiresAt
                    }
                    completion = await attempt(model)
                    lastError = null
                }
            } catch {
                // ignore import failures
            }

            if (completion) {
                // already retried with imported tokens
            } else {
                try {
                    const refreshed = await refreshCodexAccessToken(effectiveAccount.refreshToken, effectiveAccount.authSource)
                    effectiveAccount.accessToken = refreshed.accessToken
                    if (refreshed.refreshToken) {
                        effectiveAccount.refreshToken = refreshed.refreshToken
                    }
                    if (refreshed.expiresIn) {
                        effectiveAccount.expiresAt = Date.now() + refreshed.expiresIn * 1000
                    }
                    authStore.saveAccount(effectiveAccount)
                    completion = await attempt(model)
                    lastError = null
                } catch (retryError) {
                    if (isRefreshTokenReuseError(retryError)) {
                        effectiveAccount.refreshToken = undefined
                        authStore.saveAccount(effectiveAccount)
                        const latest = authStore.getAccount("codex", effectiveAccount.id)
                        if (latest?.accessToken && latest.accessToken !== effectiveAccount.accessToken) {
                            effectiveAccount.accessToken = latest.accessToken
                            effectiveAccount.refreshToken = latest.refreshToken || effectiveAccount.refreshToken
                            effectiveAccount.expiresAt = latest.expiresAt || effectiveAccount.expiresAt
                            completion = await attempt(model)
                            lastError = null
                        } else {
                            try {
                                const imported = await importCodexAuthSources()
                                const updated = imported.accounts.find(acc =>
                                    acc.id === effectiveAccount.id ||
                                    (acc.email && acc.email === effectiveAccount.email)
                                )
                                if (updated?.accessToken && updated.accessToken !== effectiveAccount.accessToken) {
                                    effectiveAccount.accessToken = updated.accessToken
                                    effectiveAccount.refreshToken = updated.refreshToken || effectiveAccount.refreshToken
                                    effectiveAccount.expiresAt = updated.expiresAt || effectiveAccount.expiresAt
                                    completion = await attempt(model)
                                    lastError = null
                                } else {
                                    lastError = new UpstreamError("codex", 401, (retryError as Error).message)
                                }
                            } catch {
                                lastError = new UpstreamError("codex", 401, (retryError as Error).message)
                            }
                        }
                    } else {
                        lastError = retryError
                    }
                }
            }
        }

        if (!completion && lastError instanceof UpstreamError && shouldFallbackModel(model, lastError) && DEFAULT_FALLBACK_MODEL !== model) {
            consola.warn(`Codex model ${model} failed, retrying with fallback ${DEFAULT_FALLBACK_MODEL}`)
            completion = await attempt(DEFAULT_FALLBACK_MODEL)
            resolvedModel = DEFAULT_FALLBACK_MODEL
            lastError = null
        }

        if (!completion && lastError) {
            throw lastError
        }
    }

    if (!completion) {
        consola.error("Codex: completion is null/undefined before empty checks")
        throw new UpstreamError("codex", 500, "Empty completion")
    }

    // Debug log to understand why completion is considered empty
    const isEmpty1 = isEmptyCompletion(completion)
    if (isEmpty1) {
        consola.warn("Codex completion considered empty (first check). Structure:", JSON.stringify(completion).slice(0, 800))
    }

    if (isEmpty1 && resolvedModel !== DEFAULT_FALLBACK_MODEL) {
        consola.warn(`Codex model ${resolvedModel} returned empty completion, retrying with fallback ${DEFAULT_FALLBACK_MODEL}`)
        try {
            completion = await attempt(DEFAULT_FALLBACK_MODEL)
            resolvedModel = DEFAULT_FALLBACK_MODEL
        } catch (fallbackError) {
            consola.error("Codex fallback attempt failed:", fallbackError)
            throw fallbackError
        }
    }

    const isEmpty2 = isEmptyCompletion(completion)
    if (isEmpty2) {
        consola.warn("Codex completion still empty after fallback. Returning empty response.", JSON.stringify(completion).slice(0, 400))
        return {
            contentBlocks: [{ type: "text" as const, text: "" }],
            stopReason: "end_turn" as const,
            usage: {
                inputTokens: completion.usage?.prompt_tokens || 0,
                outputTokens: completion.usage?.completion_tokens || 0,
            },
            resolvedModel,
        }
    }

    const choice = completion.choices?.[0]
    const content = choice?.message?.content || ""
    const toolCalls = choice?.message?.tool_calls || []

    const contentBlocks = []
    if (toolCalls.length > 0) {
        for (const call of toolCalls) {
            contentBlocks.push({
                type: "tool_use" as const,
                id: call.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                name: call.function?.name || "tool",
                input: safeParse(call.function?.arguments),
            })
        }
    }
    if (content) {
        contentBlocks.push({ type: "text" as const, text: content })
    }

    authStore.markSuccess("codex", effectiveAccount.id)

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: completion.usage?.prompt_tokens || 0,
            outputTokens: completion.usage?.completion_tokens || 0,
        },
        resolvedModel,
    }
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Codex tool args parse failed:", error)
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}
