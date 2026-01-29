/**
 * Antigravity OAuth 登录服务
 * 完整的 OAuth 登录流程实现
 */

import { state } from "~/lib/state"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import consola from "consola"
import {
    startOAuthCallbackServer,
    generateState,
    generateAuthURL,
    exchangeCode,
    fetchUserInfo,
    getProjectID,
    refreshAccessToken,
} from "./oauth"
import { generateMockProjectId } from "./project-id"
import { ensureDataDir, getDataDir, getLegacyProjectDataDir } from "~/lib/data-dir"

const AUTH_FILE = join(getDataDir(), "auth.json")
const LEGACY_AUTH_FILE = join(getLegacyProjectDataDir(), "auth.json")

interface AuthData {
    accessToken: string
    refreshToken: string
    userEmail?: string
    userName?: string
    expiresAt?: number
    projectId?: string
}

/**
 * 初始化认证 - 从文件加载已保存的认证
 */
export function initAuth(): void {
    try {
        const source = existsSync(AUTH_FILE) ? AUTH_FILE : (existsSync(LEGACY_AUTH_FILE) ? LEGACY_AUTH_FILE : null)
        if (source) {
            const data = JSON.parse(readFileSync(source, "utf-8")) as AuthData
            if (data.accessToken) {
                state.accessToken = data.accessToken
                state.antigravityToken = data.accessToken
                state.refreshToken = data.refreshToken || null
                state.tokenExpiresAt = data.expiresAt || null
                state.userEmail = data.userEmail || null
                state.userName = data.userName || null
                state.cloudaicompanionProject = data.projectId || null
                if (source === LEGACY_AUTH_FILE && !existsSync(AUTH_FILE)) {
                    saveAuth()
                }
                consola.success("Loaded saved authentication")
            }
        }
    } catch (error) {
        consola.warn("Failed to load saved auth:", error)
    }
}

/**
 * 保存认证到文件
 */
export function saveAuth(): void {
    try {
        ensureDataDir()

        const data: AuthData = {
            accessToken: state.accessToken!,
            refreshToken: state.refreshToken || "",
            expiresAt: state.tokenExpiresAt || undefined,
            userEmail: state.userEmail || undefined,
            userName: state.userName || undefined,
            projectId: state.cloudaicompanionProject || undefined,
        }

        writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2))
        consola.success("Authentication saved")
    } catch (error) {
        consola.error("Failed to save auth:", error)
    }
}

/**
 * 清除认证
 */
export function clearAuth(): void {
    state.accessToken = null
    state.antigravityToken = null
    state.refreshToken = null
    state.userEmail = null
    state.userName = null
    state.cloudaicompanionProject = null

    try {
        if (existsSync(AUTH_FILE)) {
            writeFileSync(AUTH_FILE, "{}")
        }
        if (existsSync(LEGACY_AUTH_FILE)) {
            writeFileSync(LEGACY_AUTH_FILE, "{}")
        }
    } catch (error) {
        consola.warn("Failed to clear auth file:", error)
    }
}

/**
 * 检查是否已认证
 */
export function isAuthenticated(): boolean {
    return !!state.accessToken
}

/**
 * 获取用户信息
 */
export function getUserInfo(): { email: string | null; name: string | null } {
    return {
        email: state.userEmail,
        name: state.userName,
    }
}

/**
 * 设置认证信息
 */
export function setAuth(accessToken: string, refreshToken?: string, email?: string, name?: string): void {
    state.accessToken = accessToken
    state.antigravityToken = accessToken
    state.refreshToken = refreshToken || null
    state.userEmail = email || null
    state.userName = name || null
    saveAuth()
}

/**
 * 启动 OAuth 登录流程（非阻塞模式，返回授权 URL）
 */
export interface OAuthSession {
    sessionId: string
    authUrl: string
    redirectUri: string
    oauthState: string
    server: { stop: () => void }
    waitForCallback: () => Promise<{ code?: string; state?: string; error?: string }>
}

const activeSessions = new Map<string, OAuthSession>()

export async function startOAuthLoginAsync(): Promise<{
    success: boolean
    status: "pending" | "error"
    sessionId?: string
    authUrl?: string
    error?: string
}> {
    try {
        // 1. 启动回调服务器
        const { server, port, waitForCallback } = await startOAuthCallbackServer()

        // 2. 生成授权 URL
        const oauthState = generateState()
        const sessionId = oauthState // 用 state 作为 session ID
        const redirectUri = process.env.ANTI_API_OAUTH_REDIRECT_URL || `http://localhost:${port}/oauth-callback`
        const authUrl = generateAuthURL(redirectUri, oauthState)

        // 3. 保存 session
        const session: OAuthSession = {
            sessionId,
            authUrl,
            redirectUri,
            oauthState,
            server,
            waitForCallback,
        }
        activeSessions.set(sessionId, session)

        // 4. 设置超时自动清理（5分钟）
        setTimeout(() => {
            const s = activeSessions.get(sessionId)
            if (s) {
                try { s.server.stop() } catch {}
                activeSessions.delete(sessionId)
            }
        }, 5 * 60 * 1000)

        consola.info(`Open this URL to login: ${authUrl}`)

        return {
            success: true,
            status: "pending",
            sessionId,
            authUrl,
        }
    } catch (error) {
        consola.error("OAuth login failed:", error)
        return { success: false, status: "error", error: (error as Error).message }
    }
}

export async function pollOAuthSession(sessionId: string): Promise<{
    status: "pending" | "success" | "error"
    email?: string
    error?: string
}> {
    const session = activeSessions.get(sessionId)
    if (!session) {
        return { status: "error", error: "Session not found or expired" }
    }

    // 检查回调是否已经完成（非阻塞检查）
    const result = await Promise.race([
        session.waitForCallback(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ])

    if (result === null) {
        // 还没收到回调
        return { status: "pending" }
    }

    // 收到回调了，处理结果
    try {
        session.server.stop()
    } catch {}
    activeSessions.delete(sessionId)

    if (result.error) {
        return { status: "error", error: result.error }
    }

    if (!result.code || !result.state) {
        return { status: "error", error: "Missing code or state in callback" }
    }

    if (result.state !== session.oauthState) {
        return { status: "error", error: "State mismatch - possible CSRF attack" }
    }

    try {
        // 交换 code 获取 tokens
        const tokens = await exchangeCode(result.code, session.redirectUri)

        // 获取用户信息
        const userInfo = await fetchUserInfo(tokens.accessToken)

        // 获取 Project ID
        const projectId = await getProjectID(tokens.accessToken)
        const resolvedProjectId = projectId || generateMockProjectId()
        if (!projectId) {
            consola.warn(`No project ID returned, using fallback: ${resolvedProjectId}`)
        }

        // 保存认证信息
        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        state.refreshToken = tokens.refreshToken
        state.tokenExpiresAt = Date.now() + tokens.expiresIn * 1000
        state.userEmail = userInfo.email
        state.userName = userInfo.email.split("@")[0]
        state.cloudaicompanionProject = resolvedProjectId

        saveAuth()

        consola.success(`✓ Login successful: ${userInfo.email}`)
        consola.success(`✓ Project ID: ${resolvedProjectId}`)

        return { status: "success", email: userInfo.email }
    } catch (error) {
        consola.error("OAuth token exchange failed:", error)
        return { status: "error", error: (error as Error).message }
    }
}

/**
 * 启动 OAuth 登录流程（阻塞模式，兼容旧代码）
 */
export async function startOAuthLogin(): Promise<{ success: boolean; error?: string; email?: string }> {
    let oauthServer: { stop: () => void } | null = null
    try {

        // 1. 启动回调服务器
        const { server, port, waitForCallback } = await startOAuthCallbackServer()
        oauthServer = server

        // 2. 生成授权 URL
        const oauthState = generateState()
        const redirectUri = process.env.ANTI_API_OAUTH_REDIRECT_URL || `http://localhost:${port}/oauth-callback`
        const authUrl = generateAuthURL(redirectUri, oauthState)

        // 3. 打开浏览器
        consola.info(`Open this URL to login: ${authUrl}`)
        if (process.env.ANTI_API_OAUTH_NO_OPEN !== "1") {
            try {
                await Bun.$`open ${authUrl}`.quiet()
            } catch {
                consola.warn("Failed to open browser automatically")
            }
        }

        // 4. 等待回调（5分钟超时）
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Authentication timeout (5 minutes)")), 5 * 60 * 1000)
        })

        const callbackResult = await Promise.race([
            waitForCallback(),
            timeoutPromise,
        ])

        // 5. 关闭服务器
        server.stop()
        oauthServer = null

        // 6. 检查回调结果
        if (callbackResult.error) {
            return { success: false, error: callbackResult.error }
        }

        if (!callbackResult.code || !callbackResult.state) {
            return { success: false, error: "Missing code or state in callback" }
        }

        if (callbackResult.state !== oauthState) {
            return { success: false, error: "State mismatch - possible CSRF attack" }
        }

        // 7. 交换 code 获取 tokens
        const tokens = await exchangeCode(callbackResult.code, redirectUri)

        // 8. 获取用户信息
        const userInfo = await fetchUserInfo(tokens.accessToken)

        // 9. 获取 Project ID
        const projectId = await getProjectID(tokens.accessToken)
        const resolvedProjectId = projectId || generateMockProjectId()
        if (!projectId) {
            consola.warn(`No project ID returned, using fallback: ${resolvedProjectId}`)
        }

        // 10. 保存认证信息
        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        state.refreshToken = tokens.refreshToken
        state.tokenExpiresAt = Date.now() + tokens.expiresIn * 1000
        state.userEmail = userInfo.email
        state.userName = userInfo.email.split("@")[0]
        state.cloudaicompanionProject = resolvedProjectId

        saveAuth()

        consola.success(`✓ Login successful: ${userInfo.email}`)
        consola.success(`✓ Project ID: ${resolvedProjectId}`)

        return { success: true, email: userInfo.email }
    } catch (error) {
        consola.error("OAuth login failed:", error)
        return { success: false, error: (error as Error).message }
    } finally {
        if (oauthServer) {
            try {
                oauthServer.stop()
            } catch {
                // Best-effort cleanup for abandoned OAuth attempts
            }
        }
    }
}

/**
 * 刷新 access token
 */
export async function refreshToken(): Promise<boolean> {
    if (!state.refreshToken) {
        return false
    }

    try {
        const tokens = await refreshAccessToken(state.refreshToken)
        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        saveAuth()
        consola.success("Token refreshed successfully")
        return true
    } catch (error) {
        consola.error("Token refresh failed:", error)
        return false
    }
}
