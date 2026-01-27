/**
 * /v1/images/generations 路由
 * OpenAI-compatible image generation endpoint
 */

import { Hono } from "hono"
import { forwardError } from "~/lib/error"
import { handleImageGeneration } from "./handler"

export const imageRoutes = new Hono()

// POST /v1/images/generations
imageRoutes.post("/generations", async (c) => {
    try {
        return await handleImageGeneration(c)
    } catch (error) {
        return await forwardError(c, error)
    }
})
