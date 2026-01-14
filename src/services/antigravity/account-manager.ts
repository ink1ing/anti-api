/**
 * 多账号管理器
 * 支持多个 Google 账号，当一个账号配额耗尽时自动切换
 */

import { state } from "~/lib/state"
import { refreshAccessToken, getProjectID } from "./oauth"
import { generateMockProjectId } from "./project-id"
import * as fs from "fs"
import * as path from "path"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import { parseRetryDelay } from "~/lib/retry"
import { fetchAntigravityModels, pickResetTime } from "./quota-fetch"
import { UpstreamError } from "~/lib/error"

type RateLimitReason =
    | "quota_exhausted"
    | "rate_limit_exceeded"
    | "model_capacity_exhausted"
    | "server_error"
    | "unknown"

function parseRateLimitReason(statusCode: number, errorText: string): RateLimitReason {
    if (statusCode !== 429) {
        if (statusCode >= 500) {
            return "server_error"
        }
        return "unknown"
    }

    const trimmed = errorText.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const json = JSON.parse(trimmed)
            const reason = json?.error?.details?.[0]?.reason
            if (typeof reason === "string") {
                if (reason === "QUOTA_EXHAUSTED") return "quota_exhausted"
                if (reason === "RATE_LIMIT_EXCEEDED") return "rate_limit_exceeded"
                if (reason === "MODEL_CAPACITY_EXHAUSTED") return "model_capacity_exhausted"
            }

            const message = json?.error?.message
            if (typeof message === "string") {
                const msgLower = message.toLowerCase()
                if (msgLower.includes("per minute") || msgLower.includes("rate limit")) {
                    return "rate_limit_exceeded"
                }
            }
        } catch {
            // ignore JSON parse errors
        }
    }

    const lower = errorText.toLowerCase()
    if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests")) {
        return "rate_limit_exceeded"
    }
    if (lower.includes("model_capacity") || lower.includes("capacity")) {
        return "model_capacity_exhausted"
    }
    if (lower.includes("exhausted") || lower.includes("quota")) {
        return "quota_exhausted"
    }
    return "unknown"
}

function defaultRateLimitMs(reason: RateLimitReason, failures: number): number {
    switch (reason) {
        case "quota_exhausted": {
            // [智能限流] 根据连续失败次数动态调整锁定时间
            // 第1次: 60s, 第2次: 5min, 第3次: 30min, 第4次+: 2h
            if (failures <= 1) {
                consola.warn("检测到配额耗尽 (QUOTA_EXHAUSTED)，第1次失败，锁定 60秒")
                return 60_000
            }
            if (failures === 2) {
                consola.warn("检测到配额耗尽 (QUOTA_EXHAUSTED)，第2次连续失败，锁定 5分钟")
                return 5 * 60_000
            }
            if (failures === 3) {
                consola.warn("检测到配额耗尽 (QUOTA_EXHAUSTED)，第3次连续失败，锁定 30分钟")
                return 30 * 60_000
            }
            consola.warn(`检测到配额耗尽 (QUOTA_EXHAUSTED)，第${failures}次连续失败，锁定 2小时`)
            return 2 * 60 * 60_000
        }
        case "rate_limit_exceeded":
            // 速率限制：通常是短暂的，使用较短的默认值（30秒）
            consola.debug("检测到速率限制 (RATE_LIMIT_EXCEEDED)，使用默认值 30秒")
            return 30_000
        case "model_capacity_exhausted":
            // 模型容量耗尽：服务端暂时无可用 GPU 实例
            // 这是临时性问题，使用较短的重试时间（15秒）
            consola.warn("检测到模型容量不足 (MODEL_CAPACITY_EXHAUSTED)，服务端暂无可用实例，15秒后重试")
            return 15_000
        case "server_error":
            // 服务器错误：执行"软避让"，默认锁定 20 秒
            consola.warn("检测到 5xx 错误，执行 20s 软避让...")
            return 20_000
        default:
            // 未知原因：使用中等默认值（60秒）
            consola.debug("无法解析 429 限流原因，使用默认值 60秒")
            return 60_000
    }
}

const RESET_TIME_BUFFER_MS = 2000

export interface Account {
    id: string
    email: string
    accessToken: string
    refreshToken: string
    expiresAt: number
    projectId: string | null
    // 限流状态
    rateLimitedUntil: number | null
    consecutiveFailures: number
}

class AccountManager {
    private accounts: Map<string, Account> = new Map()
    private currentIndex = 0
    private dataFile: string
    private loaded = false
    // 🆕 60秒账号锁定：记录最近使用的账号（匹配 proj-1 的 last_used_account）
    private lastUsedAccount: { accountId: string; timestamp: number } | null = null

    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "."
        this.dataFile = path.join(homeDir, ".anti-api", "accounts.json")
    }

    private ensureLoaded(): void {
        if (!this.loaded) {
            this.load()
        }
    }

    private hydrateFromAuthStore(accountId?: string): void {
        const fromStore = accountId
            ? [authStore.getAccount("antigravity", accountId)].filter(Boolean)
            : authStore.listAccounts("antigravity")

        for (const stored of fromStore) {
            if (!stored || this.accounts.has(stored.id)) continue
            this.accounts.set(stored.id, {
                id: stored.id,
                email: stored.email || stored.login || stored.id,
                accessToken: stored.accessToken,
                refreshToken: stored.refreshToken || "",
                expiresAt: stored.expiresAt || 0,
                projectId: stored.projectId || null,
                rateLimitedUntil: null,
                consecutiveFailures: 0,
            })
        }
    }

    /**
     * 加载账号列表
     */
    load(): void {
        try {
            if (fs.existsSync(this.dataFile)) {
                const data = JSON.parse(fs.readFileSync(this.dataFile, "utf-8"))
                if (Array.isArray(data.accounts)) {
                    for (const acc of data.accounts) {
                        this.accounts.set(acc.id, {
                            ...acc,
                            rateLimitedUntil: null,
                            consecutiveFailures: 0,
                        })
                        authStore.saveAccount({
                            id: acc.id,
                            provider: "antigravity",
                            email: acc.email,
                            accessToken: acc.accessToken,
                            refreshToken: acc.refreshToken,
                            expiresAt: acc.expiresAt,
                            projectId: acc.projectId || undefined,
                            label: acc.email,
                        })
                    }
                }
            }
        } catch (e) {
            consola.warn("Failed to load accounts:", e)
        }

        if (this.accounts.size === 0) {
            this.hydrateFromAuthStore()
        }

        // 如果没有已保存的账号，从 state 迁移当前账号
        if (this.accounts.size === 0 && state.accessToken && state.refreshToken) {
            const id = state.userEmail || "default"
            this.accounts.set(id, {
                id,
                email: state.userEmail || "unknown",
                accessToken: state.accessToken,
                refreshToken: state.refreshToken,
                expiresAt: state.tokenExpiresAt || 0,
                projectId: state.cloudaicompanionProject,
                rateLimitedUntil: null,
                consecutiveFailures: 0,
            })
        }

        this.loaded = true
    }

    /**
     * 保存账号列表
     */
    save(): void {
        try {
            const dir = path.dirname(this.dataFile)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            const accounts = Array.from(this.accounts.values()).map(acc => ({
                id: acc.id,
                email: acc.email,
                accessToken: acc.accessToken,
                refreshToken: acc.refreshToken,
                expiresAt: acc.expiresAt,
                projectId: acc.projectId,
            }))
            fs.writeFileSync(this.dataFile, JSON.stringify({ accounts }, null, 2))
        } catch (e) {
            consola.warn("Failed to save accounts:", e)
        }
    }

    /**
     * 添加账号
     */
    addAccount(account: Omit<Account, "rateLimitedUntil" | "consecutiveFailures">): void {
        this.accounts.set(account.id, {
            ...account,
            rateLimitedUntil: null,
            consecutiveFailures: 0,
        })
        this.save()
        authStore.saveAccount({
            id: account.id,
            provider: "antigravity",
            email: account.email,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            expiresAt: account.expiresAt,
            projectId: account.projectId || undefined,
            label: account.email,
        })
    }

    /**
     * 删除账号
     */
    removeAccount(accountIdOrEmail: string): boolean {
        // 先尝试按 ID 删除
        if (this.accounts.has(accountIdOrEmail)) {
            this.accounts.delete(accountIdOrEmail)
            this.save()
            authStore.deleteAccount("antigravity", accountIdOrEmail)
            consola.info(`Account removed: ${accountIdOrEmail}`)
            return true
        }

        // 再尝试按邮箱删除
        for (const [id, acc] of this.accounts) {
            if (acc.email === accountIdOrEmail) {
                this.accounts.delete(id)
                this.save()
                authStore.deleteAccount("antigravity", id)
                consola.info(`Account removed by email: ${accountIdOrEmail}`)
                return true
            }
        }

        consola.warn(`Account not found: ${accountIdOrEmail}`)
        return false
    }

    /**
     * 获取账号数量
     */
    count(): number {
        return this.accounts.size
    }

    /**
     * 获取所有账号邮箱
     */
    getEmails(): string[] {
        return Array.from(this.accounts.values()).map(a => a.email)
    }

    /**
     * 标记账号为限流状态
     */
    markRateLimited(accountId: string, durationMs: number = 60000): void {
        const account = this.accounts.get(accountId)
        if (account) {
            account.rateLimitedUntil = Date.now() + durationMs
            account.consecutiveFailures++
            consola.warn(`Account ${account.email} rate limited for ${durationMs / 1000}s (failures: ${account.consecutiveFailures})`)
        }
    }

    /**
     * 根据错误信息标记账号限流
     */
    async markRateLimitedFromError(
        accountId: string,
        statusCode: number,
        errorText: string,
        retryAfterHeader?: string,
        modelId?: string
    ): Promise<{ reason: RateLimitReason; durationMs: number } | null> {
        const account = this.accounts.get(accountId)
        if (!account) return null

        const reason = parseRateLimitReason(statusCode, errorText)
        const retryDelayMs = parseRetryDelay(errorText, retryAfterHeader)
        account.consecutiveFailures++

        let durationMs = 0
        let rateLimitedUntil: number | null = null

        // 🆕 proj-1 风格：不在每次 429 时检查配额（避免额外 API 调用消耗速率限制）
        // 如果没有明确的 retry delay，直接假设是速率限制并应用短暂退避
        if (retryDelayMs !== null) {
            // API 返回了明确的重试延迟
            durationMs = Math.max(retryDelayMs + 500, 2000)
            rateLimitedUntil = Date.now() + durationMs
        } else if (statusCode === 429) {
            // 没有明确延迟的 429 = 假设是速率限制，应用短暂退避
            // 不调用 fetchAntigravityModels 避免消耗速率限制
            consola.info(`Account ${account.email} got 429 without retry-after, assuming rate limit`)
            durationMs = 5000 // 5 秒短暂退避
            rateLimitedUntil = Date.now() + durationMs
            return { reason: "rate_limit_exceeded" as RateLimitReason, durationMs }
        }

        if (!rateLimitedUntil) {
            durationMs = defaultRateLimitMs(reason, account.consecutiveFailures)
            rateLimitedUntil = Date.now() + durationMs
        }

        account.rateLimitedUntil = rateLimitedUntil
        consola.warn(
            `Account ${account.email} rate limited (${reason}) for ${Math.ceil(durationMs / 1000)}s (failures: ${account.consecutiveFailures})`
        )
        return { reason, durationMs }
    }

    /**
     * 标记账号成功
     */
    markSuccess(accountId: string): void {
        const account = this.accounts.get(accountId)
        if (account) {
            account.rateLimitedUntil = null
            account.consecutiveFailures = 0
        }
    }

    /**
     * 获取下一个可用账号
     * 跳过当前被限流的账号
     */
    async getNextAvailableAccount(forceRotate: boolean = false): Promise<{
        accessToken: string
        projectId: string
        email: string
        accountId: string
    } | null> {
        this.ensureLoaded()
        if (this.accounts.size === 0) {
            this.hydrateFromAuthStore()
        }
        const now = Date.now()
        const accountList = Array.from(this.accounts.values())

        if (accountList.length === 0) {
            return null
        }

        // 🆕 60秒窗口锁定：优先复用最近使用的账号（匹配 proj-1 的设计）
        // 这避免了频繁切换账号导致的 429 错误
        if (!forceRotate && this.lastUsedAccount) {
            const { accountId, timestamp } = this.lastUsedAccount
            const elapsedMs = now - timestamp
            if (elapsedMs < 60_000) {
                const lastAccount = this.accounts.get(accountId)
                if (lastAccount && (!lastAccount.rateLimitedUntil || lastAccount.rateLimitedUntil <= now)) {
                    consola.debug(`🔒 60s Window: Reusing account ${lastAccount.email} (${Math.round(elapsedMs / 1000)}s ago)`)
                    // 刷新 token 如果需要
                    if (lastAccount.expiresAt > 0 && now > lastAccount.expiresAt - 5 * 60 * 1000) {
                        try {
                            const tokens = await refreshAccessToken(lastAccount.refreshToken)
                            lastAccount.accessToken = tokens.accessToken
                            lastAccount.expiresAt = now + tokens.expiresIn * 1000
                            this.save()
                        } catch (e) {
                            consola.warn(`Failed to refresh token for ${lastAccount.email}:`, e)
                            // 继续使用可能过期的 token，让后续请求处理错误
                        }
                    }
                    return {
                        accessToken: lastAccount.accessToken,
                        projectId: await this.ensureProjectId(lastAccount),
                        email: lastAccount.email,
                        accountId: lastAccount.id,
                    }
                }
            }
        }

        // 找到第一个可用账号
        let attempts = 0
        while (attempts < accountList.length) {
            if (forceRotate || attempts > 0) {
                this.currentIndex = (this.currentIndex + 1) % accountList.length
            }

            const account = accountList[this.currentIndex]

            // 检查是否被限流
            if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
                const waitSeconds = Math.ceil((account.rateLimitedUntil - now) / 1000)
                consola.debug(`Account ${account.email} is rate limited for ${waitSeconds}s more, trying next...`)
                attempts++
                continue
            }

            // 检查 token 是否过期，如果过期则刷新
            if (account.expiresAt > 0 && now > account.expiresAt - 5 * 60 * 1000) {
                try {
                    const tokens = await refreshAccessToken(account.refreshToken)
                    account.accessToken = tokens.accessToken
                    account.expiresAt = now + tokens.expiresIn * 1000

                    // 刷新 projectId
                    if (!account.projectId) {
                        account.projectId = await getProjectID(account.accessToken)
                    }

                    this.save()
                    authStore.saveAccount({
                        id: account.id,
                        provider: "antigravity",
                        email: account.email,
                        accessToken: account.accessToken,
                        refreshToken: account.refreshToken,
                        expiresAt: account.expiresAt,
                        projectId: account.projectId || undefined,
                        label: account.email,
                    })
                    consola.success(`Refreshed token for ${account.email}`)
                } catch (e) {
                    consola.warn(`Failed to refresh token for ${account.email}:`, e)
                    account.rateLimitedUntil = now + 60000 // 标记为暂时不可用
                    attempts++
                    continue
                }
            }

            // 🆕 更新 lastUsedAccount（60秒锁定机制）
            this.lastUsedAccount = { accountId: account.id, timestamp: Date.now() }

            return {
                accessToken: account.accessToken,
                projectId: await this.ensureProjectId(account),
                email: account.email,
                accountId: account.id,
            }
        }

        // 所有账号都被限流
        let bestAccount = accountList[0]
        let minWaitMs: number | null = null
        for (const acc of accountList) {
            if (!acc.rateLimitedUntil) {
                bestAccount = acc
                minWaitMs = 0
                break
            }
            const waitMs = Math.max(acc.rateLimitedUntil - now, 0)
            if (minWaitMs === null || waitMs < minWaitMs) {
                minWaitMs = waitMs
                bestAccount = acc
            }
        }

        if (minWaitMs !== null && minWaitMs <= 2000) {
            // 🔄 乐观重置：等待时间很短时，清除所有限流记录以解决时序竞争条件
            consola.warn(`All accounts rate limited, waiting ${Math.ceil(minWaitMs / 1000)}s for sync...`)
            await new Promise(resolve => setTimeout(resolve, 500))
            const refreshed = accountList.find(acc => !acc.rateLimitedUntil || acc.rateLimitedUntil <= Date.now())
            if (refreshed) {
                return {
                    accessToken: refreshed.accessToken,
                    projectId: refreshed.projectId || "unknown",
                    email: refreshed.email,
                    accountId: refreshed.id,
                }
            }
            // 乐观重置：清除所有限流记录
            consola.warn(`🔄 Optimistic reset: Clearing all ${accountList.length} rate limit record(s)`)
            for (const acc of accountList) {
                acc.rateLimitedUntil = null
                acc.consecutiveFailures = 0
            }
            return {
                accessToken: bestAccount.accessToken,
                projectId: bestAccount.projectId || "unknown",
                email: bestAccount.email,
                accountId: bestAccount.id,
            }
        }

        if (minWaitMs !== null && minWaitMs > 2000) {
            consola.warn(`All accounts rate limited, min wait ${Math.ceil(minWaitMs / 1000)}s`)

            // 🆕 实时配额验证：检查配额是否实际上已经恢复
            // 当锁定时间很长时，尝试实时获取配额来验证账号是否真的不可用
            consola.info(`Attempting real-time quota validation for ${accountList.length} locked account(s)...`)

            for (const acc of accountList) {
                try {
                    const result = await fetchAntigravityModels(acc.accessToken, acc.projectId)
                    const resetTime = pickResetTime(result.models)

                    // 检查是否有模型配额可用 (remainingFraction > 0)
                    const hasAvailableQuota = Object.values(result.models).some(
                        model => (model.remainingFraction ?? 0) > 0
                    )

                    if (hasAvailableQuota) {
                        consola.success(`✅ Account ${acc.email} has available quota! Clearing rate limit.`)
                        acc.rateLimitedUntil = null
                        acc.consecutiveFailures = 0
                        return {
                            accessToken: acc.accessToken,
                            projectId: await this.ensureProjectId(acc),
                            email: acc.email,
                            accountId: acc.id,
                        }
                    }

                    // 更新锁定时间为最新的 reset time
                    if (resetTime) {
                        const resetMs = Date.parse(resetTime)
                        if (Number.isFinite(resetMs)) {
                            const newLockTime = resetMs + RESET_TIME_BUFFER_MS
                            if (newLockTime !== acc.rateLimitedUntil) {
                                consola.info(`Account ${acc.email} reset time updated: ${resetTime}`)
                                acc.rateLimitedUntil = newLockTime
                            }
                        }
                    }
                } catch (error) {
                    consola.debug(`Failed to validate quota for ${acc.email}:`, error)
                }
            }

            return null
        }

        return null
    }

    /**
     * 按 ID 获取指定账号（并刷新 token）
     */
    async getAccountById(accountId: string): Promise<{
        accessToken: string
        projectId: string
        email: string
        accountId: string
    } | null> {
        this.ensureLoaded()
        if (!this.accounts.has(accountId)) {
            this.hydrateFromAuthStore(accountId)
        }
        const account = this.accounts.get(accountId)
        if (!account) return null

        const now = Date.now()
        if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
            return null
        }

        if (account.expiresAt > 0 && now > account.expiresAt - 5 * 60 * 1000) {
            try {
                const tokens = await refreshAccessToken(account.refreshToken)
                account.accessToken = tokens.accessToken
                account.expiresAt = now + tokens.expiresIn * 1000

                if (!account.projectId) {
                    account.projectId = await getProjectID(account.accessToken)
                }
                this.save()
                authStore.saveAccount({
                    id: account.id,
                    provider: "antigravity",
                    email: account.email,
                    accessToken: account.accessToken,
                    refreshToken: account.refreshToken,
                    expiresAt: account.expiresAt,
                    projectId: account.projectId || undefined,
                    label: account.email,
                })
                consola.success(`Refreshed token for ${account.email}`)
            } catch (e) {
                consola.warn(`Failed to refresh token for ${account.email}:`, e)
                account.rateLimitedUntil = now + 60000
                return null
            }
        }

        return {
            accessToken: account.accessToken,
            projectId: await this.ensureProjectId(account),
            email: account.email,
            accountId: account.id,
        }
    }

    private async fetchQuotaResetTime(account: Account, modelId?: string): Promise<number | null> {
        let refreshed = false

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const result = await fetchAntigravityModels(account.accessToken, account.projectId)
                if (!account.projectId && result.projectId) {
                    account.projectId = result.projectId
                    this.save()
                    authStore.saveAccount({
                        id: account.id,
                        provider: "antigravity",
                        email: account.email,
                        accessToken: account.accessToken,
                        refreshToken: account.refreshToken,
                        expiresAt: account.expiresAt,
                        projectId: account.projectId || undefined,
                        label: account.email,
                    })
                }

                const resetTime = pickResetTime(result.models, modelId)
                if (!resetTime) return null

                const resetMs = Date.parse(resetTime)
                if (!Number.isFinite(resetMs)) return null

                const buffered = resetMs + RESET_TIME_BUFFER_MS
                if (buffered <= Date.now()) return null
                return buffered
            } catch (error) {
                if (!refreshed && error instanceof UpstreamError && error.status === 401 && account.refreshToken) {
                    try {
                        const tokens = await refreshAccessToken(account.refreshToken)
                        account.accessToken = tokens.accessToken
                        account.expiresAt = Date.now() + tokens.expiresIn * 1000
                        this.save()
                        authStore.saveAccount({
                            id: account.id,
                            provider: "antigravity",
                            email: account.email,
                            accessToken: account.accessToken,
                            refreshToken: account.refreshToken,
                            expiresAt: account.expiresAt,
                            projectId: account.projectId || undefined,
                            label: account.email,
                        })
                        refreshed = true
                        continue
                    } catch (refreshError) {
                        consola.warn(`Failed to refresh token for ${account.email}:`, refreshError)
                        return null
                    }
                }
                return null
            }
        }

        return null
    }

    private async ensureProjectId(account: Account): Promise<string> {
        if (account.projectId && account.projectId !== "unknown") {
            return account.projectId
        }

        let resolved = await getProjectID(account.accessToken)
        if (!resolved) {
            resolved = generateMockProjectId()
            consola.warn(`Account ${account.email} missing project_id, using fallback ${resolved}`)
        }

        account.projectId = resolved
        this.save()
        authStore.saveAccount({
            id: account.id,
            provider: "antigravity",
            email: account.email,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            expiresAt: account.expiresAt,
            projectId: account.projectId || undefined,
            label: account.email,
        })
        return resolved
    }
}

// 全局单例
export const accountManager = new AccountManager()
