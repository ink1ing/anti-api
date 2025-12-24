/**
 * Anti-API HTTP服务器
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { readFileSync } from "fs"
import { join } from "path"

import { messageRoutes } from "./routes/messages/route"
import { AVAILABLE_MODELS } from "./lib/config"
import { getUserStatus } from "./services/quota"

export const server = new Hono()

// 中间件
server.use(logger())
server.use(cors())

// 根路径 - 重定向到配额面板
server.get("/", (c) => c.redirect("/quota"))

// Anthropic兼容端点
server.route("/v1/messages", messageRoutes)

// 同时支持 v1beta (某些 GUI 工具使用)
server.route("/v1beta/messages", messageRoutes)

// 无前缀版本 for GUI tools
server.route("/messages", messageRoutes)

// 模型列表处理函数 - 兼容 OpenAI 和 Anthropic 格式
const modelsHandler = (c: any) => {
    const now = new Date().toISOString()
    return c.json({
        object: "list",
        data: AVAILABLE_MODELS.map(m => ({
            id: m.id,
            type: "model",           // Anthropic format
            object: "model",         // OpenAI format
            created_at: now,         // Anthropic format (RFC 3339)
            created: Date.now(),     // OpenAI format (unix timestamp)
            owned_by: "antigravity",
            display_name: m.name,
        })),
        has_more: false,
        first_id: AVAILABLE_MODELS[0]?.id,
        last_id: AVAILABLE_MODELS[AVAILABLE_MODELS.length - 1]?.id,
    })
}

// 模型列表端点
server.get("/v1/models", modelsHandler)
server.get("/v1beta/models", modelsHandler)
server.get("/models", modelsHandler)  // 无前缀版本 for GUI tools

// 配额面板 - HTML Dashboard
server.get("/quota", async (c) => {
    try {
        const htmlPath = join(import.meta.dir, "../public/quota.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch (error) {
        return c.text("Quota dashboard not found", 404)
    }
})

// 配额数据 - JSON API
server.get("/quota/json", async (c) => {
    const snapshot = await getUserStatus()
    if (!snapshot) {
        return c.json({ error: "Failed to fetch quota" }, 500)
    }
    return c.json(snapshot)
})

// 健康检查
server.get("/health", (c) => c.json({ status: "ok" }))


