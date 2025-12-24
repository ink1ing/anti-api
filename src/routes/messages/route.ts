/**
 * /v1/messages 路由
 */

import { Hono } from "hono"
import { forwardError } from "~/lib/error"
import { handleCompletion } from "./handler"

export const messageRoutes = new Hono()

messageRoutes.post("/", async (c) => {
    try {
        return await handleCompletion(c)
    } catch (error) {
        return await forwardError(c, error)
    }
})
