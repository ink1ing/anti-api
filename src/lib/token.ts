/**
 * Anti-API Token管理
 * 从Antigravity数据库读取OAuth2 token
 * 使用Bun内置的bun:sqlite
 */

import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import consola from "consola"

import { state } from "./state"
import { AntigravityError } from "./error"

// Antigravity token数据库路径
// Windows: %APPDATA%\Antigravity\User\globalStorage\state.vscdb
// macOS/Linux: ~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb
const ANTIGRAVITY_DB_PATH = process.platform === "win32"
    ? join(
        process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
        "Antigravity/User/globalStorage/state.vscdb"
    )
    : join(
        homedir(),
        "Library/Application Support/Antigravity/User/globalStorage/state.vscdb"
    )

interface AntigravityAuthStatus {
    name: string
    apiKey: string
    email: string
    userStatusProtoBinaryBase64?: string
}

/**
 * 从Antigravity数据库读取认证token
 */
export async function setupAntigravityToken(): Promise<void> {
    consola.debug("Reading Antigravity token from:", ANTIGRAVITY_DB_PATH)

    // 检查文件是否存在
    if (!existsSync(ANTIGRAVITY_DB_PATH)) {
        throw new AntigravityError(
            "未找到Antigravity应用数据，请确保已安装并登录Antigravity",
            "db_not_found"
        )
    }

    try {
        // 使用Bun内置的SQLite
        const db = new Database(ANTIGRAVITY_DB_PATH, { readonly: true })

        // 查询antigravityAuthStatus
        const row = db.query(
            "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'"
        ).get() as { value: string } | null

        db.close()

        if (!row) {
            throw new AntigravityError(
                "未找到Antigravity认证信息，请确保已登录Antigravity应用",
                "auth_not_found"
            )
        }

        // 解析JSON
        const authStatus: AntigravityAuthStatus = JSON.parse(row.value)

        if (!authStatus.apiKey) {
            throw new AntigravityError(
                "Antigravity token无效，请重新登录Antigravity应用",
                "invalid_token"
            )
        }

        // 存储到state
        state.antigravityToken = authStatus.apiKey
        state.userEmail = authStatus.email
        state.userName = authStatus.name

        consola.debug(`User: ${authStatus.email}`)
        consola.debug("Token前缀:", authStatus.apiKey.substring(0, 10) + "...")

    } catch (error) {
        if (error instanceof AntigravityError) {
            throw error
        }

        throw new AntigravityError(
            `读取Antigravity token失败: ${(error as Error).message}`,
            "db_error"
        )
    }
}

/**
 * 获取当前token
 */
export function getToken(): string {
    if (!state.antigravityToken) {
        throw new AntigravityError("Token未初始化", "token_not_initialized")
    }
    return state.antigravityToken
}
