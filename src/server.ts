/**
 * Anti-API HTTP服务器
 */

import { Hono } from "hono"
import { cors } from "hono/cors"
import { readFileSync } from "fs"
import { join } from "path"
import consola from "consola"

import { messageRoutes } from "./routes/messages/route"
import { openaiRoutes } from "./routes/openai/route"
import { authRouter } from "./routes/auth/route"
import { remoteRouter } from "./routes/remote/route"
import { routingRouter } from "./routes/routing/route"
import { AVAILABLE_MODELS } from "./lib/config"
import { getAggregatedQuota } from "./services/quota-aggregator"
import { initAuth, isAuthenticated } from "./services/antigravity/login"
import { accountManager } from "./services/antigravity/account-manager"
export const server = new Hono()

consola.level = 0

// 中间件
server.use(async (c, next) => {
    await next()
    const reason = c.res.headers.get("X-Log-Reason") || (c.res.status < 400 ? "ok" : "error")
    console.log(`${c.res.status} ${reason}`)
})
server.use(cors())

// 启动时自动加载已保存的认证
initAuth()
accountManager.load()

// 根路径 - 重定向到配额面板
server.get("/", (c) => c.redirect("/quota"))

// Auth 路由
server.route("/auth", authRouter)

// Remote 隧道控制路由
server.route("/remote", remoteRouter)

// Routing 配置路由
server.route("/routing", routingRouter)

// Remote 控制页面 - HTML
server.get("/remote-panel", async (c) => {
    try {
        const htmlPath = join(import.meta.dir, "../public/remote.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch (error) {
        return c.text("Remote panel not found", 404)
    }
})

// 获取公网IP
server.get("/remote/public-ip", async (c) => {
    try {
        const res = await fetch("https://api.ipify.org?format=json")
        const data = await res.json() as { ip: string }
        return c.json({ ip: data.ip })
    } catch (error) {
        return c.json({ error: "Failed to get IP" }, 500)
    }
})

// OpenAI 兼容端点
server.route("/v1/chat/completions", openaiRoutes)

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
    try {
        const snapshot = await getAggregatedQuota()
        return c.json(snapshot)
    } catch (error) {
        return c.json({ error: "Failed to fetch quota" }, 500)
    }
})

// 删除账号 - API
server.delete("/accounts/:id", async (c) => {
    const accountId = c.req.param("id")
    const success = accountManager.removeAccount(accountId)
    if (success) {
        return c.json({ success: true, message: `Account ${accountId} removed` })
    }
    return c.json({ success: false, error: "Account not found" }, 404)
})

// 隧道状态 - 返回公共 URL
server.get("/tunnel/status", (c) => {
    const { state } = require("./lib/state")
    return c.json({
        active: !!state.publicUrl,
        url: state.publicUrl,
    })
})

// Embeddings 端点 - 占位（FlowDown 等客户端会请求）
server.post("/embeddings", (c) => c.json({
    error: { type: "not_supported", message: "Embeddings not supported" }
}, 501))
server.post("/v1/embeddings", (c) => c.json({
    error: { type: "not_supported", message: "Embeddings not supported" }
}, 501))

// Responses 端点 - 占位（OpenAI Responses API）
server.post("/responses", (c) => c.json({
    error: { type: "not_supported", message: "Responses API not supported" }
}, 501))
server.post("/v1/responses", (c) => c.json({
    error: { type: "not_supported", message: "Responses API not supported" }
}, 501))

// 健康检查
server.get("/health", (c) => c.json({
    status: "ok",
    authenticated: isAuthenticated(),
}))
