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
import { formatLogTime } from "~/lib/logger"

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
    size?: string       // Size hint (e.g., "1024x1024")
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
    imageSize: string
}

/**
 * Parse model name suffix to extract image configuration
 * Examples:
 *   gemini-3-pro-image -> { aspectRatio: "1:1", imageSize: "2K" }
 *   gemini-3-pro-image-4k -> { aspectRatio: "1:1", imageSize: "4K" }
 *   gemini-3-pro-image-4k-16x9 -> { aspectRatio: "16:9", imageSize: "4K" }
 *   gemini-3-pro-image-2k-9x16 -> { aspectRatio: "9:16", imageSize: "2K" }
 */
function parseImageModelConfig(modelName: string): ImageConfig {
    const normalized = modelName.toLowerCase()

    // Default values
    let imageSize = "2K"
    let aspectRatio = "1:1"

    // Parse size (4k or 2k)
    if (normalized.includes("4k")) {
        imageSize = "4K"
    } else if (normalized.includes("2k")) {
        imageSize = "2K"
    }

    // Parse aspect ratio
    if (normalized.includes("16x9") || normalized.includes("16-9")) {
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

    return { aspectRatio, imageSize }
}

/**
 * Build the Antigravity image generation request
 */
function buildImageGenRequest(prompt: string, imageConfig: ImageConfig, projectId: string): any {
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
            generationConfig: {
                candidateCount: 1,
                imageConfig: {
                    aspectRatio: imageConfig.aspectRatio,
                    imageSize: imageConfig.imageSize
                }
            }
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
    modelName?: string
): Promise<any> {
    const startTime = Date.now()
    let lastError: Error | null = null
    let lastStatusCode = 0
    let lastErrorText = ""

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
            consola.warn("Image API error " + response.status, lastErrorText.substring(0, 200))

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
 * Generate images using Antigravity's Gemini 3 Pro Image model
 */
export async function generateImages(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    // Get account
    let accessToken: string
    let accountId: string | undefined
    let projectId: string

    const account = await accountManager.getNextAvailableAccount()
    if (account) {
        accessToken = account.accessToken
        accountId = account.accountId
        projectId = account.projectId
    } else {
        accessToken = await getAccessToken()
        projectId = state.cloudaicompanionProject || "unknown"
    }

    // Parse model configuration
    const imageConfig = parseImageModelConfig(request.model)

    // Build request
    const antigravityRequest = buildImageGenRequest(request.prompt, imageConfig, projectId)

    // Generate images (support multiple if requested)
    const numImages = Math.min(request.n || 1, 4)  // Max 4 images
    const allImages: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> = []

    for (let i = 0; i < numImages; i++) {
        try {
            const result = await sendImageRequest(
                antigravityRequest,
                accessToken,
                accountId,
                request.model
            )

            for (const imageData of result.images) {
                if (request.response_format === "url") {
                    // Convert base64 to data URL for "url" format
                    const dataUrl = `data:${result.mimeType};base64,${imageData}`
                    allImages.push({ url: dataUrl, revised_prompt: request.prompt })
                } else {
                    allImages.push({ b64_json: imageData, revised_prompt: request.prompt })
                }
            }
        } catch (error) {
            consola.error(`Image generation attempt ${i + 1} failed:`, error)
            if (i === 0) throw error  // Fail on first attempt
        }
    }

    if (allImages.length === 0) {
        throw new Error("No images generated")
    }

    // Record usage
    import("~/services/usage-tracker").then(({ recordUsage }) => {
        recordUsage(request.model, 100, 0)  // Estimate 100 input tokens for image gen
    }).catch(() => {})

    return {
        created: Math.floor(Date.now() / 1000),
        data: allImages
    }
}
