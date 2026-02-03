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
const PROVIDER_FETCH_TIMEOUT_MS = 4000

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T, label: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise
    }
    return new Promise(resolve => {
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            consola.warn(`${label} quota fetch timed out after ${timeoutMs}ms, using cached data`)
            resolve(fallback())
        }, timeoutMs)
        promise.then(result => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }).catch(error => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            consola.warn(`${label} quota fetch failed, using cached data:`, error)
            resolve(fallback())
        })
    })
}

function defaultCodexBars(): AccountBar[] {
    return [
        { key: "session", label: "5h", percentage: 0 },
        { key: "week", label: "week", percentage: 0 },
    ]
}

function defaultCopilotBars(): AccountBar[] {
    return [{ key: "premium", label: "premium", percentage: 0 }]
}

function buildCachedViews(provider: QuotaCacheEntry["provider"], accounts: ProviderAccount[]): AccountQuotaView[] {
    return accounts.map(account => {
        const displayName = account.email || account.login || account.id
        const cachedBars = getCachedBars(provider, account.id)
        const bars = cachedBars || (
            provider === "antigravity"
                ? buildAntigravityBars({})
                : provider === "codex"
                    ? defaultCodexBars()
                    : defaultCopilotBars()
        )
        return {
            provider,
            accountId: account.id,
            displayName,
            bars,
        }
    })
}

export async function getAggregatedQuota(): Promise<{
    timestamp: string
    accounts: AccountQuotaView[]
}> {
    loadQuotaCache()
    accountManager.load()

    const antigravityAccounts = authStore.listAccounts("antigravity")
    const codexAccounts = authStore.listAccounts("codex")
    const copilotAccounts = authStore.listAccounts("copilot")

    const [antigravity, codex, copilot] = await Promise.all([
        withTimeout(
            fetchAntigravityQuotas(antigravityAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("antigravity", antigravityAccounts),
            "Antigravity",
        ),
        withTimeout(
            fetchCodexQuotas(codexAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("codex", codexAccounts),
            "Codex",
        ),
        withTimeout(
            fetchCopilotQuotas(copilotAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("copilot", copilotAccounts),
            "Copilot",
        ),
    ])
    saveQuotaCache()

    return {
        timestamp: new Date().toISOString(),
        accounts: [...antigravity, ...codex, ...copilot],
    }
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
                return {
                    provider: "antigravity" as const,
                    accountId: account.id,
                    displayName: account.email || account.id,
                    bars,
                }
            } catch (error) {
                lastError = error as Error
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

    return [
        buildMergedBar("claude_gpt", "claude&gpt", models, claudeGptIds),
        buildMergedBar("gpro", "gpro", models, gproIds),
        buildMergedBar("gflash", "gflash", models, gflashIds),
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
            return {
                provider: "codex" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: quota,
            }
        } catch (error) {
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
            return {
                provider: "copilot" as const,
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [bar],
            }
        } catch (error) {
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
