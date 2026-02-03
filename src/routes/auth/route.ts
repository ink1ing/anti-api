/**
 * Auth 路由
 */

import { Hono } from "hono"
import { isAuthenticated, getUserInfo, setAuth, clearAuth, startOAuthLogin } from "~/services/antigravity/login"
import { accountManager } from "~/services/antigravity/account-manager"
import { state } from "~/lib/state"
import { authStore } from "~/services/auth/store"
import { debugCodexOAuth, importCodexAuthSources, startCodexCliLogin, getCodexCliLoginStatus } from "~/services/codex/oauth"
import { startCopilotDeviceFlow, pollCopilotSession, importCopilotAuthFiles } from "~/services/copilot/oauth"
import type { ProviderAccount } from "~/services/auth/types"

export const authRouter = new Hono()

type AuthExportBundle = {
    version: number
    exportedAt: string
    accounts: ProviderAccount[]
}

function normalizeImportAccounts(payload: any): ProviderAccount[] {
    if (Array.isArray(payload)) {
        return payload as ProviderAccount[]
    }
    if (payload && typeof payload === "object") {
        if (Array.isArray(payload.accounts)) {
            return payload.accounts as ProviderAccount[]
        }
    }
    return []
}

function isValidProvider(provider: unknown): provider is ProviderAccount["provider"] {
    return provider === "antigravity" || provider === "codex" || provider === "copilot"
}

function sanitizeAccount(raw: ProviderAccount): ProviderAccount | null {
    if (!raw || typeof raw !== "object") return null
    if (!isValidProvider(raw.provider)) return null
    if (!raw.id || typeof raw.id !== "string") return null
    if (!raw.accessToken || typeof raw.accessToken !== "string") return null

    return {
        id: raw.id,
        provider: raw.provider,
        email: raw.email,
        login: raw.login,
        label: raw.label,
        accessToken: raw.accessToken,
        refreshToken: raw.refreshToken,
        expiresAt: raw.expiresAt,
        projectId: raw.projectId,
        authSource: raw.authSource,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
    }
}

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

// 导出账号（用于跨机器迁移）
authRouter.get("/export", (c) => {
    accountManager.load()
    const accounts = [
        ...authStore.listAccounts("antigravity"),
        ...authStore.listAccounts("codex"),
        ...authStore.listAccounts("copilot"),
    ]
    const bundle: AuthExportBundle = {
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts,
    }
    return c.json(bundle)
})

// 导入账号（用于跨机器迁移）
authRouter.post("/import", async (c) => {
    accountManager.load()
    const body = await c.req.json()
    const mode = typeof body?.mode === "string" ? body.mode : "merge"
    const incoming = normalizeImportAccounts(body)

    if (!Array.isArray(incoming) || incoming.length === 0) {
        return c.json({ success: false, error: "No accounts provided" }, 400)
    }

    const accounts = incoming
        .map(sanitizeAccount)
        .filter((account): account is ProviderAccount => !!account)

    if (accounts.length === 0) {
        return c.json({ success: false, error: "No valid accounts in payload" }, 400)
    }

    if (mode === "replace") {
        const providers = new Set(accounts.map(account => account.provider))
        if (providers.has("antigravity")) {
            for (const acc of authStore.listAccounts("antigravity")) {
                accountManager.removeAccount(acc.id)
            }
        }
        if (providers.has("codex")) {
            for (const acc of authStore.listAccounts("codex")) {
                authStore.deleteAccount("codex", acc.id)
            }
        }
        if (providers.has("copilot")) {
            for (const acc of authStore.listAccounts("copilot")) {
                authStore.deleteAccount("copilot", acc.id)
            }
        }
    }

    let imported = 0
    for (const account of accounts) {
        if (account.provider === "antigravity") {
            accountManager.addAccount({
                id: account.id,
                email: account.email || account.login || account.id,
                accessToken: account.accessToken,
                refreshToken: account.refreshToken || "",
                expiresAt: account.expiresAt || 0,
                projectId: account.projectId || null,
            })
        } else {
            authStore.saveAccount(account)
        }
        imported += 1
    }

    return c.json({ success: true, imported })
})

// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: { accessToken?: string; refreshToken?: string; email?: string; name?: string; provider?: string; force?: boolean } = {}
        try {
            const text = await c.req.text()
            if (text && text.trim()) {
                body = JSON.parse(text)
            }
        } catch {
            // body 为空或无效 JSON
        }

        const provider = (body.provider || "antigravity").toLowerCase()
        const forceInteractive = body.force === true

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
            const result = await startOAuthLogin()
            if (result.success) {
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
                return c.json({
                    success: true,
                    authenticated: true,
                    provider: "antigravity",
                    email: result.email,
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
