/**
 * Image Generation Handler
 * Handles /v1/images/generations endpoint (OpenAI-compatible)
 */

import type { Context } from "hono"
import { generateImages, type ImageGenerationRequest } from "~/services/antigravity/image-generation"

interface OpenAIImageRequest {
    model?: string
    prompt: string
    n?: number
    size?: string
    quality?: string
    response_format?: "url" | "b64_json"
    style?: string
    user?: string
}

export async function handleImageGeneration(c: Context) {
    const body = await c.req.json() as OpenAIImageRequest

    if (!body.prompt) {
        return c.json({
            error: {
                type: "invalid_request_error",
                message: "prompt is required"
            }
        }, 400)
    }

    // Map model name - default to base image model
    let model = body.model || "gemini-3-pro-image"

    // Normalize common OpenAI model names
    if (model === "dall-e-3" || model === "dall-e-2") {
        model = "gemini-3-pro-image"
    }

    const request: ImageGenerationRequest = {
        model,
        prompt: body.prompt,
        n: body.n || 1,
        size: body.size,
        quality: body.quality,
        style: body.style,
        response_format: body.response_format || "b64_json"
    }

    const response = await generateImages(request)

    return c.json(response)
}
