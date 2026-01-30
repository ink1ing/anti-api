import consola from "consola"
import https from "https"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"

// Disable TLS certificate verification for Copilot API calls
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

const COPILOT_COMPLETIONS_URL = "https://api.githubcopilot.com/chat/completions"
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models"

interface CopilotTokenResponse {
    token: string
    expires_at?: number
}

interface CopilotModelInfo {
    id: string
    name?: string
    model_picker_enabled?: boolean
    vendor?: string
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const modelsCache = new Map<string, { models: CopilotModelInfo[]; expiresAt: number }>()

// Map internal model names to Copilot API compatible names
// Based on GitHub Copilot Pro supported models:
// Anthropic: claude-haiku-4.5, claude-opus-4.1, claude-opus-4.5, claude-sonnet-4, claude-sonnet-4.5
// OpenAI: gpt-4.1, gpt-4o, gpt-5, gpt-5-mini, gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.2
// Google: gemini-2.5-pro, gemini-3-flash, gemini-3-pro
function mapCopilotModelName(model: string): string {
    const modelMappings: Record<string, string> = {
        // Claude models - map hyphenated to dotted format
        "claude-sonnet-4-5": "claude-sonnet-4.5",
        "claude-sonnet-4-5-thinking": "claude-sonnet-4.5", // No thinking variant in Copilot
        "claude-opus-4-5": "claude-opus-4.5",
        "claude-opus-4-5-thinking": "claude-opus-4.5",
        "claude-opus-4-1": "claude-opus-4.1",
        "claude-haiku-4-5": "claude-haiku-4.5",
        "claude-sonnet-4": "claude-sonnet-4",
        // GPT models
        "gpt-4.1": "gpt-4.1",
        "gpt-4.1-mini": "gpt-4.1-mini",
        "gpt-4o": "gpt-4o",
        "gpt-4o-mini": "gpt-4o-mini",
        "gpt-5": "gpt-5",
        "gpt-5-mini": "gpt-5-mini",
        "gpt-5.1": "gpt-5.1",
        "gpt-5.1-codex": "gpt-5.1-codex",
        "gpt-5.2": "gpt-5.2",
        // Gemini models
        "gemini-2.5-pro": "gemini-2.5-pro",
        "gemini-3-flash": "gemini-3-flash",
        "gemini-3-pro": "gemini-3-pro",
    }

    const mapped = modelMappings[model]
    if (mapped) {
        return mapped
    }
    return model
}

/**
 * 验证并映射模型名到 Copilot 支持的格式
 *
 * @param apiToken - Copilot API token
 * @param requestedModel - 规范化后的模型名（如 claude-sonnet-4-5-thinking）
 * @returns Copilot 支持的模型名（如 claude-sonnet-4）
 * @throws Error 如果模型不受支持且无可用回退
 */
async function validateAndMapModel(
    apiToken: string,
    requestedModel: string
): Promise<string> {
    // 第一步：应用现有映射规则
    const mappedModel = mapCopilotModelName(requestedModel)

    // 第二步：获取 Copilot 可用模型列表（带缓存）
    const availableModels = await fetchCopilotModels(apiToken)

    // 如果无法获取模型列表，尝试使用映射后的模型
    if (availableModels.length === 0) {
        consola.warn(`[Copilot] Could not fetch model list, attempting with: ${mappedModel}`)
        return mappedModel
    }

    const modelIds = availableModels.map(m => m.id)
    consola.debug(`[Copilot] Available models: ${modelIds.slice(0, 10).join(', ')}`)

    // 第三步：验证映射后的模型是否支持
    if (modelIds.includes(mappedModel)) {
        return mappedModel
    }

    // 第四步：尝试回退映射
    const fallbacks: Record<string, string[]> = {
        "claude-sonnet-4.5": ["claude-sonnet-4"],
        "claude-opus-4.5": ["claude-opus-4.1"],
        "claude-haiku-4.5": ["claude-haiku-4"],
    }

    const fallbackList = fallbacks[mappedModel] || []
    for (const fallback of fallbackList) {
        if (modelIds.includes(fallback)) {
            consola.info(`[Copilot] Model ${mappedModel} not available, using fallback: ${fallback}`)
            return fallback
        }
    }

    // 第五步：所有尝试失败，抛出错误让路由切换 provider
    const errorMsg = `Copilot does not support model: ${requestedModel} (mapped: ${mappedModel}). Available: ${modelIds.slice(0, 5).join(', ')}`
    consola.warn(`[Copilot] ${errorMsg}`)

    // 抛出 Error（不是 UpstreamError），让 router 捕获后跳过此 provider
    throw new Error(errorMsg)
}

interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function createCopilotCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
) {
    const apiToken = await getCopilotApiToken(account)

    // Validate and map model name with automatic fallback
    const mappedModel = await validateAndMapModel(apiToken, model)

    const requestBody = {
        model: mappedModel,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
    }

    const response = await fetchInsecureJson(COPILOT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "User-Agent": "anti-api/1.0",
            "Editor-Version": "vscode/1.95.0",
            "Editor-Plugin-Version": "copilot/1.300.0",
        },
        body: JSON.stringify(requestBody),
    })

    if (response.status < 200 || response.status >= 300) {
        consola.error(`[Copilot] Error ${response.status} for model ${mappedModel} (requested: ${model}):`, response.text.slice(0, 500))
        throw new UpstreamError("copilot", response.status, response.text, undefined)
    }

    const data = response.data as OpenAIResponse
    const choice = data?.choices?.[0]
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

    authStore.markSuccess("copilot", account.id)

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    }
}

async function getCopilotApiToken(account: ProviderAccount): Promise<string> {
    const cached = tokenCache.get(account.id)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.token
    }

    const response = await fetchInsecureJson(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    })

    const data = response.data as CopilotTokenResponse
    if (response.status < 200 || response.status >= 300 || !data?.token) {
        throw new Error(`copilot:token:${response.status}:${response.text}`)
    }

    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + 10 * 60 * 1000
    tokenCache.set(account.id, { token: data.token, expiresAt })
    return data.token
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Copilot tool args parse failed:", error)
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}

async function fetchCopilotModels(apiToken: string): Promise<CopilotModelInfo[]> {
    const cached = modelsCache.get(apiToken)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.models
    }

    try {
        const response = await fetchInsecureJson(COPILOT_MODELS_URL, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Accept": "application/json",
                "User-Agent": "GithubCopilot/1.0",
                "Editor-Version": "vscode/1.100.0",
                "Editor-Plugin-Version": "copilot/1.300.0",
            },
        })

        if (response.status < 200 || response.status >= 300) {
            consola.warn("Failed to fetch Copilot models:", response.status)
            return []
        }

        const data = response.data as { data: CopilotModelInfo[] }
        const models = data?.data || []

        modelsCache.set(apiToken, { models, expiresAt: Date.now() + 5 * 60 * 1000 })
        return models
    } catch (error) {
        consola.warn("Error fetching Copilot models:", error)
        return []
    }
}

// Insecure JSON fetch using Node.js https module to bypass TLS certificate errors
type InsecureResponse = { status: number; data: any; text: string }

async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<InsecureResponse> {
    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api/1.0",
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
                timeout: 30000,
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
