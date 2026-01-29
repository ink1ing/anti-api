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
import { MIN_REQUEST_INTERVAL_MS } from "~/lib/constants"
import { fetchAntigravityModels, pickResetTime } from "./quota-fetch"
import { UpstreamError } from "~/lib/error"
import { getDataDir } from "~/lib/data-dir"
import { isAccountDisabled } from "~/services/routing/config"

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

    // 🆕 首先尝试解析 JSON 以获取精确的 reason
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const json = JSON.parse(trimmed)
            const details = json?.error?.details

            // 检查 details 中是否有明确的 reason
            if (Array.isArray(details)) {
                for (const detail of details) {
                    const reason = detail?.reason
                    if (typeof reason === "string") {
                        if (reason === "QUOTA_EXHAUSTED") return "quota_exhausted"
                        if (reason === "RATE_LIMIT_EXCEEDED") return "rate_limit_exceeded"
                        if (reason === "MODEL_CAPACITY_EXHAUSTED") return "model_capacity_exhausted"
                    }
                }
            }

            // 检查 message 中的关键词
            const message = json?.error?.message
            if (typeof message === "string") {
                const msgLower = message.toLowerCase()
                // 🆕 proj-1 风格：优先检查 rate limit 关键词
                if (msgLower.includes("per minute") || msgLower.includes("rate limit") || msgLower.includes("too many requests")) {
                    return "rate_limit_exceeded"
                }
            }

            // 🆕 RESOURCE_EXHAUSTED 状态但没有明确的 QUOTA_EXHAUSTED detail
            // 默认假设是速率限制而非配额耗尽
            const status = json?.error?.status
            if (status === "RESOURCE_EXHAUSTED") {
                return "rate_limit_exceeded"
            }
        } catch {
            // ignore JSON parse errors
        }
    }

    const lower = errorText.toLowerCase()
    // 🆕 proj-1 风格：优先检查 rate limit 关键词
    if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests")) {
        return "rate_limit_exceeded"
    }
    if (lower.includes("model_capacity") || lower.includes("capacity")) {
        return "model_capacity_exhausted"
    }
    // 只有明确包含 "quota" 关键词时才认为是配额耗尽
    if (lower.includes("quota")) {
        return "quota_exhausted"
    }
    // 🆕 "exhausted" without "quota" = assume rate limit (short-lived)
    if (lower.includes("exhausted")) {
        return "rate_limit_exceeded"
    }
    return "unknown"
}

function defaultRateLimitMs(reason: RateLimitReason, failures: number): number {
    switch (reason) {
        case "quota_exhausted": {
            // [智能限流] 根据连续失败次数动态调整锁定时间
            // 第1次: 60s, 第2次: 5min, 第3次: 30min, 第4次+: 2h
            if (failures <= 1) {
                consola.warn("Detected quota exhausted (QUOTA_EXHAUSTED), 1st failure, lock for 60s")
                return 60_000
            }
            if (failures === 2) {
                consola.warn("Detected quota exhausted (QUOTA_EXHAUSTED), 2nd consecutive failure, lock for 5 minutes")
                return 5 * 60_000
            }
            if (failures === 3) {
                consola.warn("Detected quota exhausted (QUOTA_EXHAUSTED), 3rd consecutive failure, lock for 30 minutes")
                return 30 * 60_000
            }
            consola.warn(`Detected quota exhausted (QUOTA_EXHAUSTED), ${failures} consecutive failures, lock for 2 hours`)
            return 2 * 60 * 60_000
        }
        case "rate_limit_exceeded":
            // 速率限制：通常是短暂的，使用较短的默认值（30秒）
            return 30_000
        case "model_capacity_exhausted":
            // 模型容量耗尽：服务端暂时无可用 GPU 实例
            // 这是临时性问题，使用较短的重试时间（15秒）
            consola.warn("Detected model capacity exhausted (MODEL_CAPACITY_EXHAUSTED), retrying in 15s")
            return 15_000
        case "server_error":
            // 服务器错误：执行"软避让"，默认锁定 20 秒
            consola.warn("Detected 5xx error, backing off for 20s...")
            return 20_000
        default:
            // 未知原因：使用中等默认值（60秒）
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
    // 🆕 粘性账户队列：失败的账户移到队尾，避免反复 429
    private accountQueue: string[] = []
    // 🆕 账号并发控制（同一账号同一时刻只处理一个请求）
    private inFlightAccounts = new Set<string>()
    private accountLocks = new Map<string, Promise<void>>()
    private lastCallByAccount = new Map<string, number>()

    constructor() {
        this.dataFile = path.join(getDataDir(), "accounts.json")
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

        // 🆕 修复：移除从 state 迁移账号的逻辑
        // 不再自动 fallback 到 state.accessToken，强制用户通过正式流程添加账号
        // 这样可以确保所有账号都经过禁用/配额检查

        // 🆕 确保干净启动：清除上次使用的账号记录
        this.lastUsedAccount = null

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
        // 🆕 添加到队列末尾
        if (!this.accountQueue.includes(account.id)) {
            this.accountQueue.push(account.id)
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
    }

    /**
     * 删除账号
     */
    removeAccount(accountIdOrEmail: string): boolean {
        // 🆕 从队列中移除的辅助函数
        const removeFromQueue = (id: string) => {
            const idx = this.accountQueue.indexOf(id)
            if (idx !== -1) this.accountQueue.splice(idx, 1)
        }

        // 先尝试按 ID 删除
        if (this.accounts.has(accountIdOrEmail)) {
            this.accounts.delete(accountIdOrEmail)
            removeFromQueue(accountIdOrEmail)
            this.inFlightAccounts.delete(accountIdOrEmail)
            this.accountLocks.delete(accountIdOrEmail)
            this.lastCallByAccount.delete(accountIdOrEmail)
            this.save()
            authStore.deleteAccount("antigravity", accountIdOrEmail)
            return true
        }

        // 再尝试按邮箱删除
        for (const [id, acc] of this.accounts) {
            if (acc.email === accountIdOrEmail) {
                this.accounts.delete(id)
                removeFromQueue(id)
                this.inFlightAccounts.delete(id)
                this.accountLocks.delete(id)
                this.lastCallByAccount.delete(id)
                this.save()
                authStore.deleteAccount("antigravity", id)
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
     * 🆕 检查账号是否存在
     */
    hasAccount(accountId: string): boolean {
        this.ensureLoaded()
        return this.accounts.has(accountId)
    }

    /**
     * 🆕 账号是否正在处理请求
     */
    isAccountInFlight(accountId: string): boolean {
        return this.inFlightAccounts.has(accountId)
    }

    /**
     * 🆕 获取账号锁，确保同一账号串行处理
     */
    async acquireAccountLock(accountId: string): Promise<() => void> {
        this.ensureLoaded()
        const previous = this.accountLocks.get(accountId) || Promise.resolve()
        let resolveNext: () => void

        const next = new Promise<void>(resolve => {
            resolveNext = resolve
        })

        const tail = previous.then(() => next)
        this.accountLocks.set(accountId, tail)

        await previous

        const lastCall = this.lastCallByAccount.get(accountId) || 0
        const elapsed = Date.now() - lastCall
        if (elapsed < MIN_REQUEST_INTERVAL_MS) {
            await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed))
        }
        this.lastCallByAccount.set(accountId, Date.now())

        this.inFlightAccounts.add(accountId)

        let released = false
        return () => {
            if (released) return
            released = true
            this.inFlightAccounts.delete(accountId)
            resolveNext!()
            if (this.accountLocks.get(accountId) === tail) {
                this.accountLocks.delete(accountId)
            }
        }
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
        modelId?: string,
        options?: { maxDurationMs?: number }
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
            durationMs = 10000 // 10 秒短暂退避（增加以避免快速重试）
            rateLimitedUntil = Date.now() + durationMs
        }

        if (!rateLimitedUntil) {
            durationMs = defaultRateLimitMs(reason, account.consecutiveFailures)
            rateLimitedUntil = Date.now() + durationMs
        }

        const maxDurationMs = options?.maxDurationMs
        if (maxDurationMs && reason !== "quota_exhausted" && durationMs > maxDurationMs) {
            durationMs = maxDurationMs
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
     * 检查账号是否被限流
     */
    isAccountRateLimited(accountId: string): boolean {
        const account = this.accounts.get(accountId)
        if (!account) return false
        return account.rateLimitedUntil !== null && account.rateLimitedUntil > Date.now()
    }

    /**
     * 🆕 将失败的账户移到队尾（粘性账户策略）
     * 这样下次会优先使用队首的账户
     */
    moveToEndOfQueue(accountId: string): void {
        const index = this.accountQueue.indexOf(accountId)
        if (index !== -1) {
            this.accountQueue.splice(index, 1)
            this.accountQueue.push(accountId)
        }
    }

    /**
     * 🆕 确保账户队列已初始化
     */
    private ensureQueueInitialized(): void {
        if (this.accountQueue.length === 0 && this.accounts.size > 0) {
            this.accountQueue = Array.from(this.accounts.keys())
        }
    }

    /**
     * 🆕 乐观重置：清除所有账户的限流状态
     * 用于当所有账户都被限流但等待时间很短时，解决时序竞争条件
     */
    clearAllRateLimits(): void {
        let count = 0
        for (const account of this.accounts.values()) {
            if (account.rateLimitedUntil !== null) {
                account.rateLimitedUntil = null
                account.consecutiveFailures = 0
                count++
            }
        }
        if (count > 0) {
            consola.warn(`🔄 Optimistic reset: Cleared rate limits for ${count} account(s)`)
        }
    }

    /**
     * 🆕 获取所有账户中最短的限流等待时间（毫秒）
     * 返回 null 表示没有账户被限流
     */
    getMinRateLimitWait(): number | null {
        const now = Date.now()
        let minWait: number | null = null

        for (const account of this.accounts.values()) {
            if (account.rateLimitedUntil !== null && account.rateLimitedUntil > now) {
                const wait = account.rateLimitedUntil - now
                if (minWait === null || wait < minWait) {
                    minWait = wait
                }
            }
        }

        return minWait
    }

    /**
     * 获取下一个可用账号
     * 🆕 粘性策略：使用队列顺序，队首优先
     * @param forceRotate 是否强制轮换账号
     * @param modelId 模型ID（用于检查特定配额，如画图模型需要 gimage 配额）
     */
    async getNextAvailableAccount(forceRotate: boolean = false, modelId?: string): Promise<{
        accessToken: string
        projectId: string
        email: string
        accountId: string
    } | null> {
        // 🆕 入口日志：确保一定输出
        console.log(`[AccountManager] getNextAvailableAccount called: forceRotate=${forceRotate}, modelId=${modelId || 'undefined'}`)

        this.ensureLoaded()
        if (this.accounts.size === 0) {
            this.hydrateFromAuthStore()
        }
        this.ensureQueueInitialized()

        const now = Date.now()

        if (this.accounts.size === 0) {
            console.log(`[AccountManager] ❌ No accounts available`)
            return null
        }

        console.log(`[AccountManager] Total accounts: ${this.accounts.size}, Queue: ${this.accountQueue.length}`)

        // 🆕 读取配额保留设置
        const { getSetting } = await import("~/services/settings")
        const reservePercent = getSetting("quotaReservePercent") || 0

        console.log(`[AccountManager] Quota reserve setting: ${reservePercent}%`)

        // 🆕 检查账号是否有足够的配额（支持所有模型类型 + 配额保留）
        const hasModelQuota = async (accountId: string): Promise<boolean> => {
            if (!modelId) {
                console.log(`[AccountManager] Skipping quota check (no modelId specified)`)
                return true // 没有指定模型，不检查配额
            }

            const account = this.accounts.get(accountId)
            if (!account) {
                console.log(`[AccountManager] ❌ Account ${accountId} not found`)
                return false
            }

            const { getAccountModelQuotaPercent } = await import("~/services/quota-aggregator")

            // ✅ 修复：传入正确的 provider 参数
            const quotaPercent = getAccountModelQuotaPercent("antigravity", accountId, modelId)

            // 如果获取配额失败（返回 null），说明缓存为空或未刷新
            if (quotaPercent === null) {
                consola.warn(`⚠️  No quota cache for ${account.email}, model ${modelId}. Please refresh quota in Dashboard!`)
                // 🔴 改为保守策略：假设无配额，跳过该账号
                return false
            }

            // 打印调试信息（使用 console.log 确保输出）
            console.log(`[Account] ${account.email}: ${modelId} quota = ${quotaPercent}%, reserve = ${reservePercent}%`)

            // 配额必须高于保留阈值
            const hasQuota = quotaPercent > reservePercent
            if (!hasQuota) {
                console.log(`[Account] ${account.email}: ${quotaPercent}% <= ${reservePercent}% (reserve), insufficient quota`)
            }
            return hasQuota
        }

        // 🆕 是否存在空闲账号（避免选中正在处理的账号）
        const hasIdleAccount = this.accountQueue.some((id) => {
            const account = this.accounts.get(id)
            if (!account) return false
            if (account.rateLimitedUntil && account.rateLimitedUntil > now) return false
            return !this.inFlightAccounts.has(id)
        })

        // 🆕 粘性策略：使用队列顺序，队首账户优先
        // 如果不是强制轮换，且队首账户可用，则使用它
        if (!forceRotate && this.accountQueue.length > 0) {
            const firstId = this.accountQueue[0]
            const firstAccount = this.accounts.get(firstId)
            if (firstAccount && (!firstAccount.rateLimitedUntil || firstAccount.rateLimitedUntil <= now)) {
                // 🆕 最高优先级：检查账户是否被手动禁用
                if (isAccountDisabled("antigravity", firstId)) {
                    console.log(`[AccountManager] Skipping ${firstAccount.email}: account manually disabled`)
                } else {
                // 🆕 检查模型配额（包含配额保留）
                const hasQuota = await hasModelQuota(firstId)
                if (hasIdleAccount && this.inFlightAccounts.has(firstId)) {
                    // Prefer idle accounts when available
                } else if (!hasQuota) {
                    // 该账号配额不足（低于保留阈值），跳过
                    console.log(`[Account] ${firstAccount.email} has insufficient quota for ${modelId} (${reservePercent}% reserve), skipping...`)
                } else {
                // 刷新 token 如果需要
                if (firstAccount.expiresAt > 0 && now > firstAccount.expiresAt - 5 * 60 * 1000) {
                    try {
                        const tokens = await refreshAccessToken(firstAccount.refreshToken)
                        firstAccount.accessToken = tokens.accessToken
                        firstAccount.expiresAt = now + tokens.expiresIn * 1000
                        this.save()
                    } catch (e) {
                        consola.warn(`Failed to refresh token for ${firstAccount.email}:`, e)
                    }
                }
                this.lastUsedAccount = { accountId: firstAccount.id, timestamp: now }
                return {
                    accessToken: firstAccount.accessToken,
                    projectId: await this.ensureProjectId(firstAccount),
                    email: firstAccount.email,
                    accountId: firstAccount.id,
                }
                }
                }
            }
        }

        // 按队列顺序找第一个可用账户
        for (const accountId of this.accountQueue) {
            const account = this.accounts.get(accountId)
            if (!account) continue

            // 🆕 最高优先级：检查账户是否被手动禁用
            if (isAccountDisabled("antigravity", accountId)) {
                console.log(`[AccountManager] Skipping ${account.email}: account manually disabled`)
                continue
            }

            // 检查是否被限流
            if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
                const waitSeconds = Math.ceil((account.rateLimitedUntil - now) / 1000)
                continue
            }
            if (hasIdleAccount && this.inFlightAccounts.has(accountId)) {
                continue
            }

            // 🆕 检查模型配额（包含配额保留）
            const hasQuota = await hasModelQuota(accountId)
            if (!hasQuota) {
                console.log(`[Account] ${account.email} has insufficient quota for ${modelId} (${reservePercent}% reserve), skipping...`)
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
                } catch (e) {
                    consola.warn(`Failed to refresh token for ${account.email}:`, e)
                    account.rateLimitedUntil = now + 60000 // 标记为暂时不可用
                    continue
                }
            }

            // 🆕 更新 lastUsedAccount
            this.lastUsedAccount = { accountId: account.id, timestamp: Date.now() }

            return {
                accessToken: account.accessToken,
                projectId: await this.ensureProjectId(account),
                email: account.email,
                accountId: account.id,
            }
        }

        // 所有账号都被跳过（禁用/配额不足/限流）
        // 🆕 修复：不再 fallback 到被禁用或配额不足的账户，直接返回 null
        console.log(`[AccountManager] ❌ No available accounts (all disabled, insufficient quota, or rate limited)`)
        return null
    }

    /**
     * 按 ID 获取指定账号（并刷新 token）
     * 🆕 增强：添加禁用检查和配额检查
     */
    async getAccountById(accountId: string, modelId?: string): Promise<{
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

        // 🆕 检查是否被手动禁用
        if (isAccountDisabled("antigravity", accountId)) {
            console.log(`[AccountManager] Account ${accountId} is disabled`)
            return null
        }

        const now = Date.now()
        if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
            return null
        }

        // 🆕 检查配额（如果提供了 modelId）
        if (modelId) {
            const { getAccountModelQuotaPercent } = await import("~/services/quota-aggregator")
            const { getSetting } = await import("~/services/settings")
            const reservePercent = getSetting("quotaReservePercent") || 0
            const quotaPercent = getAccountModelQuotaPercent("antigravity", accountId, modelId)
            if (quotaPercent !== null && quotaPercent <= reservePercent) {
                console.log(`[AccountManager] Account ${accountId} has insufficient quota for ${modelId}: ${quotaPercent}% <= ${reservePercent}%`)
                return null
            }
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
