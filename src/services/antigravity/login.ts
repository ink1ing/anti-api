/**
 * Antigravity OAuth 登录服务
 * 完整的 OAuth 登录流程实现
 */

import { state } from "~/lib/state"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
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

const AUTH_FILE = join(process.cwd(), "data", "auth.json")

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
        if (existsSync(AUTH_FILE)) {
            const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as AuthData
            if (data.accessToken) {
                state.accessToken = data.accessToken
                state.antigravityToken = data.accessToken
                state.refreshToken = data.refreshToken || null
                state.tokenExpiresAt = data.expiresAt || null
                state.userEmail = data.userEmail || null
                state.userName = data.userName || null
                state.cloudaicompanionProject = data.projectId || null
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
        const dir = join(process.cwd(), "data")
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

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
 * 启动 OAuth 登录流程
 */
export async function startOAuthLogin(): Promise<{ success: boolean; error?: string; email?: string }> {
    try {
        consola.info("Starting OAuth login flow...")

        // 1. 启动回调服务器
        const { server, port, waitForCallback } = await startOAuthCallbackServer()
        consola.info(`OAuth callback server started on port ${port}`)

        // 2. 生成授权 URL
        const oauthState = generateState()
        const redirectUri = `http://localhost:${port}/oauth-callback`
        const authUrl = generateAuthURL(redirectUri, oauthState)

        // 3. 打开浏览器
        consola.info("Opening browser for authentication...")
        consola.info(`If browser doesn't open, visit: ${authUrl}`)

        try {
            await Bun.$`open ${authUrl}`.quiet()
        } catch (e) {
            consola.warn("Failed to open browser automatically")
        }

        // 4. 等待回调（5分钟超时）
        consola.info("Waiting for authentication callback...")
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Authentication timeout (5 minutes)")), 5 * 60 * 1000)
        })

        const callbackResult = await Promise.race([
            waitForCallback(),
            timeoutPromise,
        ])

        // 5. 关闭服务器
        server.stop()

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
        consola.info("Exchanging authorization code for tokens...")
        const tokens = await exchangeCode(callbackResult.code, redirectUri)

        // 8. 获取用户信息
        consola.info("Fetching user information...")
        const userInfo = await fetchUserInfo(tokens.accessToken)

        // 9. 获取 Project ID
        consola.info("Fetching project ID...")
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
