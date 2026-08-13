/**
 * Remote 隧道控制路由
 */

import { Hono } from "hono"
import { state } from "~/lib/state"
import {
    getAllTunnelStatus,
    getSavedConfig,
    clearSavedNgrokAuthtoken,
    startCloudflared,
    stopCloudflared,
    startNgrok,
    stopNgrok,
    startLocaltunnel,
    stopLocaltunnel,
} from "~/services/tunnel-manager"

export const remoteRouter = new Hono()

// 获取所有隧道状态
remoteRouter.get("/status", (c) => {
    return c.json(getAllTunnelStatus())
})

// 获取保存的配置
remoteRouter.get("/config", (c) => {
    return c.json(getSavedConfig())
})

// Cloudflared
remoteRouter.post("/cloudflared/start", async (c) => {
    const status = await startCloudflared(state.port)
    return c.json(status)
})

remoteRouter.post("/cloudflared/stop", (c) => {
    const status = stopCloudflared()
    return c.json(status)
})

// ngrok
remoteRouter.post("/ngrok/start", async (c) => {
    const body: { authtoken?: string; clearAuthtoken?: boolean } = await c.req.json<{ authtoken?: string; clearAuthtoken?: boolean }>().catch(() => ({}))
    if (body.clearAuthtoken) clearSavedNgrokAuthtoken()
    const status = await startNgrok(state.port, body.authtoken)
    return c.json(status)
})

remoteRouter.post("/ngrok/stop", (c) => {
    const status = stopNgrok()
    return c.json(status)
})

// localtunnel
remoteRouter.post("/localtunnel/start", async (c) => {
    const body: { subdomain?: string } = await c.req.json<{ subdomain?: string }>().catch(() => ({}))
    const status = await startLocaltunnel(state.port, body.subdomain)
    return c.json(status)
})

remoteRouter.post("/localtunnel/stop", (c) => {
    const status = stopLocaltunnel()
    return c.json(status)
})
