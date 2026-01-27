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
        model = "gemini-3-pro-image-4k"
    }

    // Map size to aspect ratio suffix if not already present
    if (body.size && !model.includes("x")) {
        const sizeMap: Record<string, string> = {
            "1024x1024": "-1x1",
            "1792x1024": "-16x9",
            "1024x1792": "-9x16",
            "1536x1024": "-16x9",
            "1024x1536": "-9x16",
        }
        const suffix = sizeMap[body.size]
        if (suffix && !model.endsWith(suffix)) {
            // Add suffix if model doesn't already have aspect ratio
            if (!model.match(/\d+x\d+$/)) {
                model = model + suffix
            }
        }
    }

    const request: ImageGenerationRequest = {
        model,
        prompt: body.prompt,
        n: body.n || 1,
        size: body.size,
        response_format: body.response_format || "b64_json"
    }

    const response = await generateImages(request)

    return c.json(response)
}
