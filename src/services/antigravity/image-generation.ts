/**
 * Antigravity Image Generation Service
 *
 * Handles image generation requests via Gemini 3 Pro Image model
 */

import consola from "consola"
import { getAccessToken } from "./oauth"
import { accountManager } from "./account-manager"
import { state } from "~/lib/state"
import { UpstreamError } from "~/lib/error"
import { formatLogTime, setRequestLogContext } from "~/lib/logger"
import { isAccountDisabled } from "~/services/routing/config"
import { getAccountModelQuotaPercent } from "~/services/quota-aggregator"
import { getSetting } from "~/services/settings"

const ANTIGRAVITY_BASE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]
const STREAM_ENDPOINT = "/v1internal:streamGenerateContent"
const DEFAULT_USER_AGENT = "antigravity/1.11.9 windows/amd64"
const FETCH_TIMEOUT_MS = 120000  // Image generation may take longer

// Image model name is always "gemini-3-pro-image" for the API
const IMAGE_MODEL_NAME = "gemini-3-pro-image"

export interface ImageGenerationRequest {
    model: string       // User-provided model name (e.g., "gemini-3-pro-image-4k-16x9")
    prompt: string
    n?: number          // Number of images (default 1)
    size?: string       // Size hint (e.g., "1024x1024", "1920x1080")
    quality?: string    // Quality hint ("standard", "hd", "medium")
    style?: string      // Style hint ("vivid", "natural")
    response_format?: "url" | "b64_json"
}

export interface ImageGenerationResponse {
    created: number
    data: Array<{
        url?: string
        b64_json?: string
        revised_prompt?: string
    }>
}

interface ImageConfig {
    aspectRatio: string
    imageSize?: string  // Optional: only set for 4K/2K quality
}

/**
 * Calculate aspect ratio from OpenAI size format (WIDTHxHEIGHT)
 * Uses tolerance matching for common aspect ratios
 */
function calculateAspectRatioFromSize(size: string): string {
    const parts = size.split("x")
    if (parts.length !== 2) return "1:1"

    const width = parseFloat(parts[0])
    const height = parseFloat(parts[1])

    if (!width || !height || width <= 0 || height <= 0) return "1:1"

    const ratio = width / height
    const tolerance = 0.1

    // Match common aspect ratios with tolerance
    if (Math.abs(ratio - 21 / 9) < tolerance) return "21:9"
    if (Math.abs(ratio - 16 / 9) < tolerance) return "16:9"
    if (Math.abs(ratio - 4 / 3) < tolerance) return "4:3"
    if (Math.abs(ratio - 3 / 4) < tolerance) return "3:4"
    if (Math.abs(ratio - 9 / 16) < tolerance) return "9:16"
    if (Math.abs(ratio - 1) < tolerance) return "1:1"

    return "1:1" // Default fallback
}

/**
 * Parse image configuration from multiple sources (with priority):
 * 1. OpenAI API parameters (size, quality) - highest priority
 * 2. Model name suffixes (e.g., -16x9, -4k) - fallback for backward compatibility
 *
 * Examples:
 *   parseImageConfig("gemini-3-pro-image", "1920x1080", "hd")
 *     -> { aspectRatio: "16:9", imageSize: "4K" }
 *   parseImageConfig("gemini-3-pro-image-4k-16x9", null, null)
 *     -> { aspectRatio: "16:9", imageSize: "4K" }
 */
function parseImageModelConfig(
    modelName: string,
    size?: string | null,
    quality?: string | null
): ImageConfig {
    const normalized = modelName.toLowerCase()

    // 1. Parse aspect ratio (size param takes priority)
    let aspectRatio = "1:1"
    if (size) {
        aspectRatio = calculateAspectRatioFromSize(size)
    } else {
        // Fallback to model suffix parsing
        if (normalized.includes("21x9") || normalized.includes("21-9")) {
            aspectRatio = "21:9"
        } else if (normalized.includes("16x9") || normalized.includes("16-9")) {
            aspectRatio = "16:9"
        } else if (normalized.includes("9x16") || normalized.includes("9-16")) {
            aspectRatio = "9:16"
        } else if (normalized.includes("4x3") || normalized.includes("4-3")) {
            aspectRatio = "4:3"
        } else if (normalized.includes("3x4") || normalized.includes("3-4")) {
            aspectRatio = "3:4"
        } else if (normalized.includes("1x1") || normalized.includes("1-1")) {
            aspectRatio = "1:1"
        }
    }

    // 2. Parse image size (quality param takes priority)
    let imageSize: string | undefined
    if (quality) {
        if (quality === "hd") {
            imageSize = "4K"
        } else if (quality === "medium") {
            imageSize = "2K"
        }
        // "standard" or other values: don't set imageSize (let API decide)
    } else {
        // Fallback to model suffix parsing
        if (normalized.includes("4k") || normalized.includes("hd")) {
            imageSize = "4K"
        } else if (normalized.includes("2k")) {
            imageSize = "2K"
        }
    }

    return { aspectRatio, imageSize }
}

/**
 * Build the Antigravity image generation request
 */
function buildImageGenRequest(prompt: string, imageConfig: ImageConfig, projectId: string): any {
    const genConfig: any = {
        candidateCount: 1,
        imageConfig: {
            aspectRatio: imageConfig.aspectRatio
        }
    }

    // Only add imageSize if explicitly set (4K/2K)
    if (imageConfig.imageSize) {
        genConfig.imageConfig.imageSize = imageConfig.imageSize
    }

    return {
        model: IMAGE_MODEL_NAME,
        userAgent: "antigravity",
        requestType: "image_gen",
        project: projectId,
        requestId: "image-" + crypto.randomUUID(),
        request: {
            contents: [
                {
                    role: "user",
                    parts: [{ text: prompt }]
                }
            ],
            generationConfig: genConfig,
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
                { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
            ]
        }
    }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...options, signal: controller.signal })
    } finally {
        clearTimeout(timeoutId)
    }
}

function extractSseEventData(event: string): string | null {
    const dataLines: string[] = []
    const lines = event.split(/\r?\n/)
    for (const line of lines) {
        if (!line.startsWith("data:")) continue
        let value = line.slice(5)
        if (value.startsWith(" ")) value = value.slice(1)
        dataLines.push(value)
    }
    if (dataLines.length === 0) return null
    return dataLines.join("\n")
}

/**
 * Send image generation request to Antigravity
 */
async function sendImageRequest(
    antigravityRequest: any,
    accessToken: string,
    accountId?: string,
    modelName?: string,
    retryAfterHeader?: string
): Promise<any> {
    const startTime = Date.now()
    let lastError: Error | null = null
    let lastStatusCode = 0
    let lastErrorText = ""
    let lastRetryAfterHeader = retryAfterHeader

    for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
        const url = baseUrl + STREAM_ENDPOINT + "?alt=sse"
        try {
            const response = await fetchWithTimeout(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + accessToken,
                    "User-Agent": DEFAULT_USER_AGENT,
                    "Accept": "text/event-stream",
                },
                body: JSON.stringify(antigravityRequest),
            }, FETCH_TIMEOUT_MS)

            if (response.ok) {
                if (accountId) accountManager.markSuccess(accountId)

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                const account = accountId ? await accountManager.getAccountById(accountId) : null
                const accountPart = account?.email ? ` >> ${account.email}` : (accountId ? ` >> ${accountId}` : "")
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${modelName || "image-gen"} > Antigravity${accountPart} (${elapsed}s)\x1b[0m`)

                const rawSse = await response.text()
                return parseImageResponse(rawSse)
            }

            lastStatusCode = response.status
            lastErrorText = await response.text()
            lastRetryAfterHeader = response.headers.get("retry-after") || undefined

            consola.warn("Image API error " + response.status, lastErrorText.substring(0, 200))

            // Handle 429 errors with account limiting
            if (response.status === 429 && accountId) {
                await accountManager.markRateLimitedFromError(
                    accountId,
                    response.status,
                    lastErrorText,
                    lastRetryAfterHeader
                )
                accountManager.moveToEndOfQueue(accountId)
            }

            if (response.status === 429 || response.status >= 500) {
                lastError = new Error("API error: " + response.status)
                continue  // Try next endpoint
            }

            throw new UpstreamError("antigravity", response.status, lastErrorText)
        } catch (e) {
            if (e instanceof UpstreamError) throw e
            lastError = e as Error
            continue
        }
    }

    if (lastStatusCode > 0) {
        throw new UpstreamError("antigravity", lastStatusCode, lastErrorText)
    }
    throw lastError || new Error("All endpoints failed")
}

/**
 * Parse image generation response from SSE stream
 */
function parseImageResponse(rawSse: string): { images: string[], mimeType: string } {
    const images: string[] = []
    let mimeType = "image/png"

    const events = rawSse.split(/\r?\n\r?\n/)
    for (const event of events) {
        const data = extractSseEventData(event)
        if (!data) continue
        const trimmed = data.trim()
        if (!trimmed || trimmed === "[DONE]") continue

        try {
            const parsed = JSON.parse(trimmed)
            const responseData = parsed.response || parsed
            const parts = responseData?.candidates?.[0]?.content?.parts || []

            for (const part of parts) {
                if (part.inlineData?.data) {
                    images.push(part.inlineData.data)
                    if (part.inlineData.mimeType) {
                        mimeType = part.inlineData.mimeType
                    }
                }
            }
        } catch {
            // Ignore parse errors
        }
    }

    return { images, mimeType }
}

/**
 * Enhance prompt based on quality and style parameters
 */
function enhancePrompt(basePrompt: string, quality?: string, style?: string): string {
    let enhanced = basePrompt

    // Add quality enhancements
    if (quality === "hd") {
        enhanced += ", (high quality, highly detailed, 4k resolution, hdr)"
    }

    // Add style enhancements
    if (style === "vivid") {
        enhanced += ", (vivid colors, dramatic lighting, rich details)"
    } else if (style === "natural") {
        enhanced += ", (natural lighting, realistic, photorealistic)"
    }

    return enhanced
}

/**
 * Generate images using Antigravity's Gemini 3 Pro Image model
 */
export async function generateImages(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const maxAttempts = 3  // 最多重试3次
    let currentAttempt = 0
    let lastError: Error | null = null
    const reservePercent = getSetting("quotaReservePercent") || 0

    while (currentAttempt < maxAttempts) {
        currentAttempt++

        // Get account with lock support
        let accessToken: string
        let accountId: string | undefined
        let accountEmail: string | undefined
        let projectId: string
        let releaseAccountLock: (() => void) | null = null

        const account = await accountManager.getNextAvailableAccount(currentAttempt > 1, request.model)  // 传入 modelId 以检查画图配额
        if (account) {
            accessToken = account.accessToken
            accountId = account.accountId
            accountEmail = account.email
            projectId = account.projectId

            // 🆕 检查账号是否被手动禁用
            if (isAccountDisabled("antigravity", accountId)) {
                console.log(`[ImageGen] Skipping ${accountEmail}: account manually disabled`)
                continue  // 跳过此账号，尝试下一个
            }

            // 🆕 检查配额是否低于保留阈值
            const quotaPercent = getAccountModelQuotaPercent("antigravity", accountId, request.model)
            if (quotaPercent !== null && quotaPercent <= reservePercent) {
                console.log(`[ImageGen] Skipping ${accountEmail}: ${request.model} quota ${quotaPercent}% <= reserve ${reservePercent}%`)
                continue  // 跳过此账号，尝试下一个
            }

            // Acquire account lock to prevent concurrent requests
            releaseAccountLock = await accountManager.acquireAccountLock(accountId)
        } else {
            // 🆕 修复：没有可用账户时抛出错误，而不是使用 fallback token
            throw new UpstreamError("antigravity", 429, "No available accounts for image generation (all disabled, insufficient quota, or rate limited)")
        }

        // Set log context for request logging (显示在控制台日志中)
        setRequestLogContext({ model: request.model, provider: "antigravity", account: accountEmail })

        // Log request start
        const accountDisplay = accountEmail ? ` >> ${accountEmail}` : ""
        const retryInfo = currentAttempt > 1 ? ` (retry ${currentAttempt}/${maxAttempts})` : ""
        console.log(`[${formatLogTime()}] ⏳ Generating image: ${request.model} > Antigravity${accountDisplay}${retryInfo}`)

        try {
            // Parse model configuration (with OpenAI parameter support)
            const imageConfig = parseImageModelConfig(request.model, request.size, request.quality)

            // Enhance prompt based on quality and style
            const finalPrompt = enhancePrompt(request.prompt, request.quality, request.style)

            // Generate images concurrently (support multiple if requested)
            const numImages = Math.min(request.n || 1, 10)  // Max 10 images
            const tasks: Promise<{ images: string[]; mimeType: string }>[] = []

            for (let i = 0; i < numImages; i++) {
                const antigravityRequest = buildImageGenRequest(finalPrompt, imageConfig, projectId)
                tasks.push(
                    sendImageRequest(antigravityRequest, accessToken, accountId, request.model)
                )
            }

            // Collect results (partial success allowed)
            const allImages: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> = []
            const errors: string[] = []

            const results = await Promise.allSettled(tasks)
            for (let i = 0; i < results.length; i++) {
                const result = results[i]
                if (result.status === "fulfilled") {
                    for (const imageData of result.value.images) {
                        if (request.response_format === "url") {
                            // Convert base64 to data URL for "url" format
                            const dataUrl = `data:${result.value.mimeType};base64,${imageData}`
                            allImages.push({ url: dataUrl, revised_prompt: finalPrompt })
                        } else {
                            allImages.push({ b64_json: imageData, revised_prompt: finalPrompt })
                        }
                    }
                } else {
                    const errorMsg = result.reason?.message || String(result.reason)
                    errors.push(errorMsg)
                }
            }

            // 检查是否所有任务都因为 429 失败
            const all429Errors = errors.every(err =>
                err.includes("429") || err.includes("resource exhausted") || err.includes("quota")
            )

            if (allImages.length === 0 && all429Errors && currentAttempt < maxAttempts) {
                // 所有任务都失败且是 429 错误，释放锁并重试下一个账号
                if (releaseAccountLock) releaseAccountLock()
                console.log(`\x1b[33m[${formatLogTime()}] 429: ${request.model} > Antigravity${accountDisplay} - switching account...\x1b[0m`)
                lastError = new Error(errors[0] || "All images failed")
                continue  // 重试下一个账号
            }

            if (allImages.length === 0) {
                const errorSummary = errors.length > 0 ? errors.join("; ") : "No images generated"
                throw new Error(`All ${numImages} image generation requests failed. ${errorSummary}`)
            }

            // Log partial success warning
            if (errors.length > 0) {
                consola.warn(
                    `Partial success: ${allImages.length} out of ${numImages} images generated. Errors: ${errors.join("; ")}`
                )
            } else {
                consola.success(`Successfully generated ${allImages.length} image(s)`)
            }

            // Record usage
            import("~/services/usage-tracker").then(({ recordUsage }) => {
                recordUsage(request.model, 100 * allImages.length, 0)  // Estimate 100 input tokens per image
            }).catch(() => {})

            // 成功，释放锁并返回
            if (releaseAccountLock) releaseAccountLock()

            return {
                created: Math.floor(Date.now() / 1000),
                data: allImages
            }
        } catch (error) {
            // 释放锁
            if (releaseAccountLock) releaseAccountLock()

            // 检查是否是 429 错误
            const errorMsg = error instanceof Error ? error.message : String(error)
            const is429Error = errorMsg.includes("429") || errorMsg.includes("resource exhausted") || errorMsg.includes("quota")

            if (is429Error && currentAttempt < maxAttempts) {
                console.log(`\x1b[33m[${formatLogTime()}] 429: ${request.model} > Antigravity${accountDisplay} - ${errorMsg.substring(0, 100)}\x1b[0m`)
                lastError = error as Error
                continue  // 重试下一个账号
            }

            // 非 429 错误或已达到最大重试次数，记录错误并抛出
            console.log(`\x1b[31m[${formatLogTime()}] ❌ ${request.model} > Antigravity${accountDisplay} - ${errorMsg.substring(0, 100)}\x1b[0m`)
            throw error
        }
    }

    // 所有重试都失败了
    throw lastError || new Error(`Failed to generate images after ${maxAttempts} attempts`)
}
