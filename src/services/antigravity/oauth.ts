/**
 * Antigravity OAuth 配置和工具函数
 * 基于 CLIProxyAPI 的实现
 */

import https from "https"
import { state } from "~/lib/state"
import { getAntigravityUserAgent } from "~/lib/antigravity-client"

// OAuth 配置（来自 CLIProxyAPI）
export const OAUTH_CONFIG = {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    callbackPort: 51121,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    projectUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
}

const PROJECT_USER_AGENT = getAntigravityUserAgent()

/**
 * 生成随机 state 用于 CSRF 保护
 */
export function generateState(): string {
    return crypto.randomUUID()
}

/**
 * 生成 OAuth 授权 URL
 */
export function generateAuthURL(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_CONFIG.scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
    })
    return `${OAUTH_CONFIG.authUrl}?${params.toString()}`
}

/**
 * 交换 authorization code 获取 tokens
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<{
    accessToken: string
    refreshToken: string
    expiresIn: number
}> {
    const params = new URLSearchParams({
        code,
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
    })

    const response = await fetchInsecureJson(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Token exchange failed: ${response.status} ${response.text}`)
    }

    const data = response.data as {
        access_token: string
        refresh_token: string
        expires_in: number
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
    }
}

/**
 * 获取用户信息（从 Google API）
 */
export async function fetchUserInfo(accessToken: string): Promise<{ email: string }> {
    const response = await fetchInsecureJson(OAUTH_CONFIG.userInfoUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    })

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to get user info: ${response.status}`)
    }

    return response.data as { email: string }
}

/**
 * 获取 Antigravity Project ID
 */
export async function getProjectID(accessToken: string): Promise<string | null> {
    try {
        const response = await fetchInsecureJson(OAUTH_CONFIG.projectUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "User-Agent": PROJECT_USER_AGENT,
            },
            body: JSON.stringify({
                metadata: {
                    ideType: "ANTIGRAVITY",
                },
            }),
        })

        if (response.status < 200 || response.status >= 300) {
            return null
        }

        const data = response.data as { cloudaicompanionProject?: string }
        return data.cloudaicompanionProject || null
    } catch {
        return null
    }
}

/**
 * 刷新 access token
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string
    expiresIn: number
}> {
    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
    })

    const response = await fetchInsecureJson(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Token refresh failed: ${response.status} ${response.text}`)
    }

    const data = response.data as {
        access_token: string
        expires_in: number
    }

    return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
    }
}

/**
 * 获取访问令牌（如果过期则自动刷新）
 */
export async function getAccessToken(): Promise<string> {
    if (!state.accessToken) {
        throw new Error("Not authenticated. Please login first.")
    }

    // 检查 token 是否过期（提前 5 分钟刷新）
    const now = Date.now()
    const expiresAt = state.tokenExpiresAt || 0
    const needsRefresh = expiresAt > 0 && (now > expiresAt - 5 * 60 * 1000)

    if (needsRefresh && state.refreshToken) {
        try {
            const tokens = await refreshAccessToken(state.refreshToken)
            state.accessToken = tokens.accessToken
            state.antigravityToken = tokens.accessToken
            state.tokenExpiresAt = now + tokens.expiresIn * 1000

            // 保存刷新后的 token
            const { saveAuth } = await import("./login")
            saveAuth()

        } catch (error) {
            // 刷新失败时抛出错误，让用户重新登录
            throw new Error("Token expired and refresh failed. Please re-login.")
        }
    }

    return state.accessToken
}

type InsecureResponse = {
    status: number
    data: any
    text: string
}

export async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<InsecureResponse> {
    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api",
        ...(options.headers || {}),
    }
    const agent = new https.Agent({ rejectUnauthorized: false })

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers,
                agent,
                rejectUnauthorized: false,
                timeout: 10000,
            },
            (res) => {
                let body = ""
                res.on("data", (chunk) => {
                    body += chunk
                })
                res.on("end", () => {
                    let data: any = null
                    if (body) {
                        try {
                            data = JSON.parse(body)
                        } catch {
                            data = null
                        }
                    }
                    resolve({
                        status: res.statusCode || 0,
                        data,
                        text: body,
                    })
                })
            }
        )

        req.on("error", reject)
        req.on("timeout", () => {
            req.destroy(new Error("Request timed out"))
        })

        if (options.body) {
            req.write(options.body)
        }
        req.end()
    })
}

/**
 * OAuth 回调服务器
 */
interface OAuthCallbackResult {
    code?: string
    state?: string
    error?: string
}

export function startOAuthCallbackServer(): Promise<{
    server: any
    port: number
    waitForCallback: () => Promise<OAuthCallbackResult>
}> {
    return new Promise((resolve, reject) => {
        let callbackResolve: ((result: OAuthCallbackResult) => void) | null = null
        const callbackPromise = new Promise<OAuthCallbackResult>((res) => {
            callbackResolve = res
        })

        const startPort = OAUTH_CONFIG.callbackPort
        const maxOffset = 10
        let server: any = null
        let boundPort = startPort

        for (let offset = 0; offset <= maxOffset; offset++) {
            const port = startPort + offset
            try {
                server = Bun.serve({
                    port,
                    fetch(req) {
                        const url = new URL(req.url)

                        if (url.pathname === "/oauth-callback") {
                            const code = url.searchParams.get("code")
                            const state = url.searchParams.get("state")
                            const error = url.searchParams.get("error")

                            if (callbackResolve) {
                                callbackResolve({ code: code || undefined, state: state || undefined, error: error || undefined })
                            }

                            // Redirect to official success page
                            return Response.redirect("https://antigravity.google/auth-success", 302)
                        }

                        return new Response("Not Found", { status: 404 })
                    },
                })
                boundPort = port
                break
            } catch (error) {
                if (offset >= maxOffset) {
                    reject(error)
                    return
                }
            }
        }

        resolve({
            server,
            port: boundPort,
            waitForCallback: () => callbackPromise,
        })
    })
}
