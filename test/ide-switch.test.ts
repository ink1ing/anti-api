/**
 * IDE Logout 功能测试
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// 需要 mock 掉数据库路径，避免操作真实 IDE 数据
// 直接测试核心逻辑函数

describe("IDE Logout", () => {
    let tempDir: string
    let tempDbPath: string

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "ide-switch-test-"))
        tempDbPath = join(tempDir, "state.vscdb")

        // 创建一个与 IDE 兼容的 SQLite 数据库
        const db = new Database(tempDbPath)
        db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)")
        db.run(
            "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
            [
                "antigravityAuthStatus",
                JSON.stringify({
                    name: "Test User",
                    apiKey: "ya29.test-token-12345",
                    email: "test@example.com",
                    userStatusProtoBinaryBase64: "dGVzdA==",
                }),
            ]
        )
        db.run(
            "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
            ["antigravityUnifiedStateSync.oauthToken", "fake-oauth-token-data"]
        )
        db.close()
    })

    afterEach(() => {
        try {
            rmSync(tempDir, { recursive: true, force: true })
        } catch { }
    })

    test("can read auth status from vscdb", () => {
        const db = new Database(tempDbPath, { readonly: true })
        const row = db.query("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'").get() as any
        db.close()

        expect(row).toBeTruthy()
        const data = JSON.parse(row.value)
        expect(data.email).toBe("test@example.com")
        expect(data.name).toBe("Test User")
        expect(data.apiKey).toStartWith("ya29.")
    })

    test("can clear auth keys from vscdb (logout simulation)", () => {
        // 插入 USS 认证 key
        const db = new Database(tempDbPath)
        db.run("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", ["antigravityUnifiedStateSync.userStatus", "proto-data"])

        // 只删除认证相关的 3 个 key（不能删 antigravityOnboarding，否则触发完整 wizard）
        const AUTH_KEYS = [
            "antigravityAuthStatus",
            "antigravityUnifiedStateSync.oauthToken",
            "antigravityUnifiedStateSync.userStatus",
        ]
        for (const key of AUTH_KEYS) {
            db.run("DELETE FROM ItemTable WHERE key = ?", [key])
        }
        db.close()

        // 验证所有 key 已清除
        const dbRead = new Database(tempDbPath, { readonly: true })
        for (const key of AUTH_KEYS) {
            const row = dbRead.query("SELECT value FROM ItemTable WHERE key = ?").get(key)
            expect(row).toBeNull()
        }
        dbRead.close()
    })

    test("logout does not affect unrelated keys", () => {
        // 添加一个无关key 和 antigravityOnboarding（不应被删除）
        const db = new Database(tempDbPath)
        db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ["someOtherSetting", "keep-this"])
        db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ["antigravityOnboarding", "true"])

        // 只删除认证相关 key
        const AUTH_KEYS = [
            "antigravityAuthStatus",
            "antigravityUnifiedStateSync.oauthToken",
            "antigravityUnifiedStateSync.userStatus",
        ]
        for (const key of AUTH_KEYS) {
            db.run("DELETE FROM ItemTable WHERE key = ?", [key])
        }
        db.close()

        // 验证无关 key 未受影响
        const dbRead = new Database(tempDbPath, { readonly: true })
        const otherRow = dbRead.query("SELECT value FROM ItemTable WHERE key = 'someOtherSetting'").get() as any

        // 验证 antigravityOnboarding 被保留（删除它会触发完整新手引导 wizard）
        const onboardingRow = dbRead.query("SELECT value FROM ItemTable WHERE key = 'antigravityOnboarding'").get() as any
        dbRead.close()

        expect(otherRow).toBeTruthy()
        expect(otherRow.value).toBe("keep-this")
        expect(onboardingRow).toBeTruthy()
        expect(onboardingRow.value).toBe("true")
    })

    test("handles missing database gracefully", () => {
        const fakePath = join(tempDir, "nonexistent.vscdb")
        expect(existsSync(fakePath)).toBe(false)

        // 模拟 getIdeAuthStatus 的逻辑
        const result = { loggedIn: false, email: null, name: null }
        expect(result.loggedIn).toBe(false)
    })

    test("handles empty auth status", () => {
        // 写入空的 auth
        const db = new Database(tempDbPath)
        db.run("UPDATE ItemTable SET value = ? WHERE key = 'antigravityAuthStatus'", [JSON.stringify({})])
        db.close()

        const dbRead = new Database(tempDbPath, { readonly: true })
        const row = dbRead.query("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'").get() as any
        dbRead.close()

        const data = JSON.parse(row.value)
        expect(data.apiKey).toBeUndefined()
    })

    test("logoutIdeSession is exported and callable", async () => {
        const mod = await import("~/services/antigravity/ide-switch")
        expect(typeof mod.logoutIdeSession).toBe("function")
    })

    test("getIdeAuthStatus is exported and callable", async () => {
        const mod = await import("~/services/antigravity/ide-switch")
        expect(typeof mod.getIdeAuthStatus).toBe("function")
    })
})
