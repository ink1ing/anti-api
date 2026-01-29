/**
 * Auth 路由
 */

import { Hono } from "hono"
import consola from "consola"
import { isAuthenticated, getUserInfo, setAuth, clearAuth, startOAuthLogin, startOAuthLoginAsync, pollOAuthSession } from "~/services/antigravity/login"
import { accountManager } from "~/services/antigravity/account-manager"
import { state } from "~/lib/state"
import { authStore } from "~/services/auth/store"
import { debugCodexOAuth, importCodexAuthSources, startCodexCliLogin, getCodexCliLoginStatus } from "~/services/codex/oauth"
import { startCopilotDeviceFlow, pollCopilotSession, importCopilotAuthFiles } from "~/services/copilot/oauth"

export const authRouter = new Hono()

// 获取认证状态
authRouter.get("/status", (c) => {
    const userInfo = getUserInfo()
    return c.json({
        authenticated: isAuthenticated(),
        email: userInfo.email,
        name: userInfo.name,
    })
})

authRouter.get("/accounts", (c) => {
    accountManager.load()
    return c.json({
        accounts: {
            antigravity: authStore.listSummaries("antigravity"),
            codex: authStore.listSummaries("codex"),
            copilot: authStore.listSummaries("copilot"),
        },
    })
})

// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    consola.info("[Auth] POST /auth/login received")
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: { accessToken?: string; refreshToken?: string; email?: string; name?: string; provider?: string; force?: boolean } = {}
        try {
            const text = await c.req.text()
            consola.info(`[Auth] Request body: ${text}`)
            if (text && text.trim()) {
                body = JSON.parse(text)
            }
        } catch {
            // body 为空或无效 JSON
        }

        const provider = (body.provider || "antigravity").toLowerCase()
        const forceInteractive = body.force === true
        consola.info(`[Auth] Provider: ${provider}, force: ${forceInteractive}`)

        if (provider === "copilot") {
            if (!forceInteractive) {
                const imported = importCopilotAuthFiles()
                if (imported.length > 0) {
                    return c.json({
                        success: true,
                        status: "success",
                        provider: "copilot",
                        source: "import",
                        login: imported[0].login,
                    })
                }
            }
            const session = await startCopilotDeviceFlow()
            return c.json({
                success: true,
                status: "pending",
                provider: "copilot",
                device_code: session.deviceCode,
                user_code: session.userCode,
                verification_uri: session.verificationUri,
                interval: session.interval,
            })
        }

        if (provider === "codex") {
            if (forceInteractive) {
                // 使用浏览器 OAuth 登录获取完整权限的 token
                try {
                    const { startCodexOAuthLogin } = await import("~/services/codex/oauth")
                    const account = await startCodexOAuthLogin()
                    return c.json({
                        success: true,
                        provider: "codex",
                        status: "success",
                        source: "browser-oauth",
                        account: {
                            id: account.id,
                            email: account.email,
                            source: account.authSource,
                        },
                    })
                } catch (error) {
                    return c.json({ success: false, error: (error as Error).message }, 400)
                }
            }

            const result = await importCodexAuthSources()
            if (result.accounts.length > 0) {
                return c.json({
                    success: true,
                    provider: "codex",
                    status: "success",
                    source: "import",
                    count: result.accounts.length,
                    sources: result.sources,
                    accounts: result.accounts.map(account => ({
                        id: account.id,
                        email: account.email,
                        source: account.authSource,
                    })),
                })
            }
            return c.json({
                success: false,
                error: "Codex auth files not found. Use force=true to login via browser.",
            }, 400)
        }

        // 默认 Antigravity
        if (!body.accessToken) {
            // 使用非阻塞模式，返回授权 URL 给前端
            const result = await startOAuthLoginAsync()
            if (result.success && result.status === "pending") {
                return c.json({
                    success: true,
                    status: "pending",
                    provider: "antigravity",
                    session_id: result.sessionId,
                    auth_url: result.authUrl,
                })
            } else {
                return c.json({ success: false, error: result.error }, 400)
            }
        }

        setAuth(body.accessToken, body.refreshToken, body.email, body.name)
        accountManager.load()
        accountManager.addAccount({
            id: body.email || `account-${Date.now()}`,
            email: body.email || "unknown",
            accessToken: body.accessToken,
            refreshToken: body.refreshToken || "",
            expiresAt: state.tokenExpiresAt || 0,
            projectId: state.cloudaicompanionProject,
        })
        return c.json({
            success: true,
            authenticated: true,
            provider: "antigravity",
            email: body.email,
            name: body.name,
        })
    } catch (error) {
        return c.json({ error: (error as Error).message }, 500)
    }
})

authRouter.get("/antigravity/status", async (c) => {
    const sessionId = c.req.query("session_id")
    if (!sessionId) {
        return c.json({ success: false, error: "session_id required" }, 400)
    }
    const result = await pollOAuthSession(sessionId)
    if (result.status === "success") {
        // 登录成功，添加到账户管理器
        accountManager.load()
        if (state.accessToken && state.refreshToken) {
            accountManager.addAccount({
                id: state.userEmail || `account-${Date.now()}`,
                email: state.userEmail || "unknown",
                accessToken: state.accessToken,
                refreshToken: state.refreshToken,
                expiresAt: state.tokenExpiresAt || 0,
                projectId: state.cloudaicompanionProject,
            })
        }
    }
    return c.json({
        success: result.status !== "error",
        status: result.status,
        email: result.email,
        error: result.error,
    })
})

authRouter.get("/copilot/status", async (c) => {
    const deviceCode = c.req.query("device_code")
    if (!deviceCode) {
        return c.json({ success: false, error: "device_code required" }, 400)
    }
    const session = await pollCopilotSession(deviceCode)
    return c.json({
        success: session.status !== "error",
        status: session.status,
        message: session.message,
        account: session.account ? {
            id: session.account.id,
            login: session.account.login,
            email: session.account.email,
        } : undefined,
    })
})

authRouter.get("/codex/status", async (c) => {
    const sessionId = c.req.query("session_id")
    if (!sessionId) {
        return c.json({ success: false, error: "session_id required" }, 400)
    }
    const result = await getCodexCliLoginStatus(sessionId)
    return c.json({
        success: result.status !== "error",
        status: result.status,
        message: result.message,
        verification_uri: result.verificationUri,
        user_code: result.userCode,
        accounts: result.accounts?.map(account => ({
            id: account.id,
            email: account.email,
            source: account.authSource,
        })),
    })
})

authRouter.get("/codex/debug", async (c) => {
    try {
        const result = await debugCodexOAuth()
        return c.json({ success: true, ...result })
    } catch (error) {
        return c.json({ success: false, error: (error as Error).message }, 500)
    }
})

// 登出
authRouter.post("/logout", (c) => {
    clearAuth()
    return c.json({ success: true, authenticated: false })
})
