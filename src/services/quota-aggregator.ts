import consola from "consola"
import https from "https"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { authStore } from "~/services/auth/store"
import { refreshAccessToken } from "~/services/antigravity/oauth"
import { fetchAntigravityModels as fetchAntigravityModelsRequest, type AntigravityModelInfo } from "~/services/antigravity/quota-fetch"
import { refreshCodexAccessToken, refreshCodexAccountIfNeeded } from "~/services/codex/oauth"
import { accountManager } from "~/services/antigravity/account-manager"
import type { ProviderAccount } from "~/services/auth/types"
import { UpstreamError } from "~/lib/error"
import { getDataDir } from "~/lib/data-dir"

type ModelInfo = AntigravityModelInfo

type AccountBar = {
    key: string
    label: string
    percentage: number
    resetTime?: string
}

export type AccountQuotaView = {
    provider: "antigravity" | "codex" | "copilot"
    accountId: string
    displayName: string
    bars: AccountBar[]
}

type QuotaCacheEntry = {
    provider: "antigravity" | "codex" | "copilot"
    accountId: string
    displayName: string
    bars: AccountBar[]
    updatedAt: string
}

const QUOTA_CACHE_DIR = getDataDir()
const QUOTA_CACHE_FILE = join(QUOTA_CACHE_DIR, "quota-cache.json")
let quotaCache = new Map<string, QuotaCacheEntry>()
let cacheLoaded = false

// 智能缓存：内存缓存有效期（毫秒）
const MEMORY_CACHE_TTL_MS = 60_000  // 60秒内直接返回内存缓存
let lastFetchTime = 0
let lastFetchResult: { timestamp: string; accounts: AccountQuotaView[] } | null = null
let isBackgroundRefreshing = false

// 超时追踪
const timeoutCounters = new Map<string, number>()  // "provider:accountId" -> 连续超时次数
const TIMEOUT_WARN_THRESHOLD = 3  // 连续超时3次后警告

function getCacheKey(provider: QuotaCacheEntry["provider"], accountId: string): string {
    return `${provider}:${accountId}`
}

function loadQuotaCache(): void {
    if (cacheLoaded) return
    cacheLoaded = true
    try {
        if (!existsSync(QUOTA_CACHE_FILE)) return
        const raw = JSON.parse(readFileSync(QUOTA_CACHE_FILE, "utf-8")) as Record<string, QuotaCacheEntry>
        quotaCache = new Map(Object.entries(raw))
    } catch {
        quotaCache = new Map()
    }
}

function saveQuotaCache(): void {
    try {
        if (!existsSync(QUOTA_CACHE_DIR)) {
            mkdirSync(QUOTA_CACHE_DIR, { recursive: true })
        }
        const payload: Record<string, QuotaCacheEntry> = {}
        for (const [key, value] of quotaCache.entries()) {
            payload[key] = value
        }
        writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(payload, null, 2))
    } catch {
        // Best-effort cache only
    }
}

function updateQuotaCache(entry: QuotaCacheEntry): void {
    quotaCache.set(getCacheKey(entry.provider, entry.accountId), entry)
}

function getCachedBars(provider: QuotaCacheEntry["provider"], accountId: string): AccountBar[] | null {
    const cached = quotaCache.get(getCacheKey(provider, accountId))
    return cached?.bars || null
}

// 超时计数管理
function recordTimeout(provider: string, accountId: string): void {
    const key = getCacheKey(provider as any, accountId)
    const count = (timeoutCounters.get(key) || 0) + 1
    timeoutCounters.set(key, count)

    if (count === TIMEOUT_WARN_THRESHOLD) {
        console.log(`\x1b[33m[Quota] ⚠️ WARNING: ${provider}/${accountId} timed out ${count} times consecutively. Check your network/proxy settings.\x1b[0m`)
    } else if (count > TIMEOUT_WARN_THRESHOLD && count % 5 === 0) {
        console.log(`\x1b[33m[Quota] ⚠️ ${provider}/${accountId} timeout count: ${count}\x1b[0m`)
    }
}

function clearTimeoutCounter(provider: string, accountId: string): void {
    const key = getCacheKey(provider as any, accountId)
    if (timeoutCounters.has(key)) {
        timeoutCounters.delete(key)
    }
}

function isTimeoutError(error: unknown): boolean {
    if (!error) return false
    const message = String((error as { message?: string }).message || "")
    return message.includes("timed out") ||
           message.includes("timeout") ||
           message.includes("ETIMEDOUT") ||
           message.includes("ECONNRESET") ||
           message.includes("ENOTFOUND")
}

/**
 * 获取账户的最低配额百分比（用于路由决策）
 * 返回该账户所有配额条中的最小值
 */
export function getAccountMinQuotaPercent(provider: "antigravity" | "codex" | "copilot", accountId: string): number | null {
    loadQuotaCache()
    const bars = getCachedBars(provider, accountId)
    if (!bars || bars.length === 0) return null
    return Math.min(...bars.map(bar => bar.percentage))
}

/**
 * 获取账户特定模型的配额百分比
 */
export function getAccountModelQuotaPercent(provider: "antigravity" | "codex" | "copilot", accountId: string, modelId: string): number | null {
    loadQuotaCache()
    const bars = getCachedBars(provider, accountId)
    if (!bars || bars.length === 0) return null

    // 根据模型类型匹配对应的配额条
    if (provider === "antigravity") {
        // Claude/GPT 模型使用 claude_gpt 配额
        if (modelId.includes("claude") || modelId.includes("gpt")) {
            const bar = bars.find(b => b.key === "claude_gpt")
            if (bar) return bar.percentage
        }
        // Gemini Image 模型使用 gimage 配额（优先检查，避免被 pro 匹配）
        if (modelId.includes("image")) {
            const bar = bars.find(b => b.key === "gimage")
            if (bar) return bar.percentage
        }
        // Gemini Pro 模型使用 gpro 配额
        if (modelId.includes("gemini") && modelId.includes("pro")) {
            const bar = bars.find(b => b.key === "gpro")
            if (bar) return bar.percentage
        }
        // Gemini Flash 模型使用 gflash 配额
        if (modelId.includes("gemini") && modelId.includes("flash")) {
            const bar = bars.find(b => b.key === "gflash")
            if (bar) return bar.percentage
        }
    }

    // 其他情况返回最低配额
    return Math.min(...bars.map(bar => bar.percentage))
}

export async function getAggregatedQuota(): Promise<{
    timestamp: string
    accounts: AccountQuotaView[]
}> {
    loadQuotaCache()
    accountManager.load()

    const now = Date.now()

    // 智能缓存：60秒内直接返回内存缓存
    if (lastFetchResult && (now - lastFetchTime) < MEMORY_CACHE_TTL_MS) {
        return lastFetchResult
    }

    // 如果有磁盘缓存且正在后台刷新，直接返回磁盘缓存
    if (isBackgroundRefreshing && quotaCache.size > 0) {
        return buildResultFromCache()
    }

    // 如果有磁盘缓存，先返回缓存，然后后台刷新
    if (quotaCache.size > 0 && !lastFetchResult) {
        const cachedResult = buildResultFromCache()
        // 后台刷新（不阻塞）
        refreshQuotasInBackground()
        return cachedResult
    }

    // 没有缓存，必须等待实际请求
    return await fetchAndCacheQuotas()
}

function buildResultFromCache(): { timestamp: string; accounts: AccountQuotaView[] } {
    const accounts: AccountQuotaView[] = []
    for (const [, entry] of quotaCache.entries()) {
        accounts.push({
            provider: entry.provider,
            accountId: entry.accountId,
            displayName: entry.displayName,
            bars: entry.bars,
        })
    }
    return {
        timestamp: new Date().toISOString(),
        accounts,
    }
}

async function refreshQuotasInBackground(): Promise<void> {
    if (isBackgroundRefreshing) return
    isBackgroundRefreshing = true

    try {
        await fetchAndCacheQuotas()
    } catch (error) {
        consola.debug("Background quota refresh failed:", error)
    } finally {
        isBackgroundRefreshing = false
    }
}

async function fetchAndCacheQuotas(): Promise<{
    timestamp: string
    accounts: AccountQuotaView[]
}> {
    const antigravityAccounts = authStore.listAccounts("antigravity")
    const codexAccounts = authStore.listAccounts("codex")
    const copilotAccounts = authStore.listAccounts("copilot")

    const [antigravity, codex, copilot] = await Promise.all([
        fetchAntigravityQuotas(antigravityAccounts),
        fetchCodexQuotas(codexAccounts),
        fetchCopilotQuotas(copilotAccounts),
    ])
    saveQuotaCache()

    const result = {
        timestamp: new Date().toISOString(),
        accounts: [...antigravity, ...codex, ...copilot],
    }

    // 更新内存缓存
    lastFetchTime = Date.now()
    lastFetchResult = result

    return result
}

async function fetchAntigravityQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        let lastError: Error | null = null

        // Retry up to 2 times for each account
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const refreshed = await refreshAntigravityToken(account)
                const quotaModels = await fetchAntigravityModelsForAccount(refreshed)
                const bars = buildAntigravityBars(quotaModels)
                updateQuotaCache({
                    provider: "antigravity",
                    accountId: account.id,
                    displayName: account.email || account.id,
                    bars,
                    updatedAt: new Date().toISOString(),
                })
                // 成功后清除超时计数
                clearTimeoutCounter("antigravity", account.id)
                return {
                    provider: "antigravity" as const,
                    accountId: account.id,
                    displayName: account.email || account.id,
                    bars,
                }
            } catch (error) {
                lastError = error as Error
                // 记录超时
                if (isTimeoutError(error)) {
                    recordTimeout("antigravity", account.id)
                }
                if (attempt < 1) {
                    // Wait 500ms before retry (reduced from 1000ms)
                    await new Promise(resolve => setTimeout(resolve, 500))
                }
            }
        }

        if (lastError) {
            if (!isCertificateError(lastError) && !isAuthError(lastError)) {
                consola.warn("Antigravity quota fetch failed:", lastError)
            }
        }
        const cachedBars = getCachedBars("antigravity", account.id)
        if (cachedBars) {
            return {
                provider: "antigravity" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: cachedBars,
            }
        }
        return {
            provider: "antigravity" as const,
            accountId: account.id,
            displayName: account.email || account.id,
            bars: buildAntigravityBars({}),
        }
    })

    return Promise.all(promises)
}

async function refreshAntigravityToken(account: ProviderAccount): Promise<ProviderAccount> {
    if (!account.refreshToken) {
        return account
    }
    if (!account.expiresAt || account.expiresAt > Date.now() + 60_000) {
        return account
    }

    try {
        const refreshed = await refreshAccessToken(account.refreshToken)
        const updated = {
            ...account,
            accessToken: refreshed.accessToken,
            expiresAt: Date.now() + refreshed.expiresIn * 1000,
        }
        authStore.saveAccount(updated)
        return updated
    } catch (error) {
        if (isCertificateError(error) || isAuthError(error)) {
            const updated = {
                ...account,
                expiresAt: 0,
            }
            authStore.saveAccount(updated)
            return updated
        }
        throw error
    }
}

async function fetchAntigravityModelsForAccount(
    account: ProviderAccount,
    hasRefreshed = false
): Promise<Record<string, ModelInfo>> {
    try {
        const result = await fetchAntigravityModelsRequest(account.accessToken, account.projectId)
        if (!account.projectId && result.projectId) {
            account.projectId = result.projectId
            authStore.saveAccount(account)
        }
        return result.models
    } catch (error) {
        if (error instanceof UpstreamError && error.status === 401 && account.refreshToken && !hasRefreshed) {
            try {
                const refreshed = await refreshAccessToken(account.refreshToken)
                account.accessToken = refreshed.accessToken
                account.expiresAt = Date.now() + refreshed.expiresIn * 1000
                authStore.saveAccount(account)
                return fetchAntigravityModelsForAccount(account, true)
            } catch (refreshError) {
                if (isCertificateError(refreshError) || isAuthError(refreshError)) {
                    return {}
                }
                throw refreshError
            }
        }

        if (error instanceof UpstreamError && error.status === 401) {
            return {}
        }

        throw error
    }
}

function buildAntigravityBars(models: Record<string, ModelInfo>): AccountBar[] {
    const claudeGptIds = [
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-thinking",
        "claude-opus-4-5-thinking",
        "gpt-oss-120b",
    ]
    const gproIds = ["gemini-3-pro-low", "gemini-3-pro-high"]
    const gflashIds = ["gemini-3-flash"]
    const gimageIds = ["gemini-3-pro-image"]

    return [
        buildMergedBar("claude_gpt", "claude&gpt", models, claudeGptIds),
        buildMergedBar("gpro", "gpro", models, gproIds),
        buildMergedBar("gflash", "gflash", models, gflashIds),
        buildMergedBar("gimage", "gimage", models, gimageIds),
    ]
}

function buildMergedBar(
    key: string,
    label: string,
    models: Record<string, ModelInfo>,
    ids: string[]
): AccountBar {
    const entries = ids
        .map(id => models[id])
        .filter(Boolean)

    if (entries.length === 0) {
        return { key, label, percentage: 0 }
    }

    const percentages = entries.map(item => Math.round((item?.remainingFraction ?? 0) * 100))
    const percentage = Math.min(...percentages)
    const resetTime = earliestResetTime(entries.map(item => item?.resetTime).filter(Boolean) as string[])
    return { key, label, percentage, resetTime }
}

function earliestResetTime(times: string[]): string | undefined {
    if (times.length === 0) return undefined
    return times.reduce((earliest, current) => {
        if (!earliest) return current
        return new Date(current).getTime() < new Date(earliest).getTime() ? current : earliest
    }, times[0])
}

async function fetchCodexQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        try {
            const updated = await refreshCodexIfNeeded(account)
            const quota = await fetchCodexUsage(updated)
            updateQuotaCache({
                provider: "codex",
                accountId: account.id,
                displayName: account.email || account.id,
                bars: quota,
                updatedAt: new Date().toISOString(),
            })
            // 成功后清除超时计数
            clearTimeoutCounter("codex", account.id)
            return {
                provider: "codex" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: quota,
            }
        } catch (error) {
            // 记录超时
            if (isTimeoutError(error)) {
                recordTimeout("codex", account.id)
            }
            if (!isCertificateError(error)) {
                consola.warn("Codex quota fetch failed:", error)
            }
            const cachedBars = getCachedBars("codex", account.id)
            if (cachedBars) {
                return {
                    provider: "codex" as const,
                    accountId: account.id,
                    displayName: account.email || account.id,
                    bars: cachedBars,
                }
            }
            return {
                provider: "codex" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: [
                    { key: "session", label: "5h", percentage: 0 },
                    { key: "week", label: "week", percentage: 0 },
                ],
            }
        }
    })
    return Promise.all(promises)
}

async function refreshCodexIfNeeded(account: ProviderAccount): Promise<ProviderAccount> {
    return refreshCodexAccountIfNeeded(account)
}

async function fetchCodexUsage(account: ProviderAccount): Promise<AccountBar[]> {
    const response = await fetchInsecureJson("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            Accept: "application/json",
        },
    })

    if (response.status === 401 && account.refreshToken) {
        const refreshed = await refreshCodexAccessToken(account.refreshToken, account.authSource)
        account.accessToken = refreshed.accessToken
        if (refreshed.expiresIn) {
            account.expiresAt = Date.now() + refreshed.expiresIn * 1000
        }
        authStore.saveAccount(account)
        return fetchCodexUsage(account)
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Codex usage error ${response.status}: ${response.text}`)
    }

    const data = response.data as any
    const rateLimit = data.rate_limit || {}
    const primary = rateLimit.primary_window || {}
    const secondary = rateLimit.secondary_window || {}

    return [
        {
            key: "session",
            label: "5h",
            percentage: 100 - (primary.used_percent || 0),
            resetTime: primary.reset_at ? new Date(primary.reset_at * 1000).toISOString() : undefined,
        },
        {
            key: "week",
            label: "week",
            percentage: 100 - (secondary.used_percent || 0),
            resetTime: secondary.reset_at ? new Date(secondary.reset_at * 1000).toISOString() : undefined,
        },
    ]
}

async function fetchCopilotQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        try {
            const bar = await fetchCopilotPremium(account)
            updateQuotaCache({
                provider: "copilot",
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [bar],
                updatedAt: new Date().toISOString(),
            })
            // 成功后清除超时计数
            clearTimeoutCounter("copilot", account.id)
            return {
                provider: "copilot" as const,
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [bar],
            }
        } catch (error) {
            // 记录超时
            if (isTimeoutError(error)) {
                recordTimeout("copilot", account.id)
            }
            consola.warn("Copilot quota fetch failed:", error)
            const cachedBars = getCachedBars("copilot", account.id)
            if (cachedBars) {
                return {
                    provider: "copilot" as const,
                    accountId: account.id,
                    displayName: account.login || account.id,
                    bars: cachedBars,
                }
            }
            return {
                provider: "copilot" as const,
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [{ key: "premium", label: "premium", percentage: 0 }],
            }
        }
    })
    return Promise.all(promises)
}

async function fetchCopilotPremium(account: ProviderAccount): Promise<AccountBar> {
    let response: InsecureResponse
    try {
        response = await fetchInsecureJson("https://api.github.com/copilot_internal/user", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${account.accessToken}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        })
    } catch (error) {
        if (isCertificateError(error)) {
            return { key: "premium", label: "premium", percentage: 0 }
        }
        throw error
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Copilot entitlement error ${response.status}: ${response.text}`)
    }

    const data = response.data as any
    const premium = data.quota_snapshots?.premium_interactions
    const percent = derivePercent(premium)
    const reset = data.quota_reset_date_utc || data.quota_reset_date || data.limited_user_reset_date

    return {
        key: "premium",
        label: "premium",
        percentage: percent,
        resetTime: reset || undefined,
    }
}

function derivePercent(snapshot: any): number {
    if (!snapshot) return 0
    if (snapshot.unlimited === true) return 100
    if (typeof snapshot.percent_remaining === "number") return Math.round(snapshot.percent_remaining)
    if (typeof snapshot.remaining === "number" && typeof snapshot.entitlement === "number") {
        if (snapshot.entitlement <= 0) return 0
        return Math.round((snapshot.remaining / snapshot.entitlement) * 100)
    }
    return 0
}

function isCertificateError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const code = (error as { code?: string }).code
    if (code === "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR") return true
    const message = String((error as { message?: string }).message || "")
    return message.toLowerCase().includes("certificate")
}

function isAuthError(error: unknown): boolean {
    if (!error) return false
    const message = String((error as { message?: string }).message || "")
    if (message.includes("401")) return true
    if (message.toLowerCase().includes("unauthenticated")) return true
    if (message.toLowerCase().includes("invalid_grant")) return true
    return false
}

type InsecureResponse = {
    status: number
    data: any
    text: string
}

async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<InsecureResponse> {
    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api",
        ...(options.headers || {}),
    }
    const insecureAgent = new https.Agent({ rejectUnauthorized: false })

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers,
                agent: insecureAgent,
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
