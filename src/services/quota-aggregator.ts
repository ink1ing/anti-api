import consola from "consola"
import https from "https"
import { authStore } from "~/services/auth/store"
import { refreshAccessToken } from "~/services/antigravity/oauth"
import { fetchAntigravityModels as fetchAntigravityModelsRequest, type AntigravityModelInfo } from "~/services/antigravity/quota-fetch"
import { refreshCodexAccessToken, refreshCodexAccountIfNeeded } from "~/services/codex/oauth"
import { accountManager } from "~/services/antigravity/account-manager"
import type { ProviderAccount } from "~/services/auth/types"
import { UpstreamError } from "~/lib/error"

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

export async function getAggregatedQuota(): Promise<{
    timestamp: string
    accounts: AccountQuotaView[]
}> {
    accountManager.load()

    const antigravityAccounts = authStore.listAccounts("antigravity")
    const codexAccounts = authStore.listAccounts("codex")
    const copilotAccounts = authStore.listAccounts("copilot")

    const [antigravity, codex, copilot] = await Promise.all([
        fetchAntigravityQuotas(antigravityAccounts),
        fetchCodexQuotas(codexAccounts),
        fetchCopilotQuotas(copilotAccounts),
    ])

    return {
        timestamp: new Date().toISOString(),
        accounts: [...antigravity, ...codex, ...copilot],
    }
}

async function fetchAntigravityQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    const results: AccountQuotaView[] = []
    for (const account of accounts) {
        try {
            const refreshed = await refreshAntigravityToken(account)
            const quotaModels = await fetchAntigravityModelsForAccount(refreshed)
            const bars = buildAntigravityBars(quotaModels)
            results.push({
                provider: "antigravity",
                accountId: account.id,
                displayName: account.email || account.id,
                bars,
            })
        } catch (error) {
            if (!isCertificateError(error) && !isAuthError(error)) {
                consola.warn("Antigravity quota fetch failed:", error)
            }
            results.push({
                provider: "antigravity",
                accountId: account.id,
                displayName: account.email || account.id,
                bars: buildAntigravityBars({}),
            })
        }
    }
    return results
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
    const results: AccountQuotaView[] = []
    for (const account of accounts) {
        try {
            const updated = await refreshCodexIfNeeded(account)
            const quota = await fetchCodexUsage(updated)
            results.push({
                provider: "codex",
                accountId: account.id,
                displayName: account.email || account.id,
                bars: quota,
            })
        } catch (error) {
            if (!isCertificateError(error)) {
                consola.warn("Codex quota fetch failed:", error)
            }
            results.push({
                provider: "codex",
                accountId: account.id,
                displayName: account.email || account.id,
                bars: [
                    { key: "session", label: "5h", percentage: 0 },
                    { key: "week", label: "week", percentage: 0 },
                ],
            })
        }
    }
    return results
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
    const results: AccountQuotaView[] = []
    for (const account of accounts) {
        try {
            const bar = await fetchCopilotPremium(account)
            results.push({
                provider: "copilot",
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [bar],
            })
        } catch (error) {
            consola.warn("Copilot quota fetch failed:", error)
            results.push({
                provider: "copilot",
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [{ key: "premium", label: "premium", percentage: 0 }],
            })
        }
    }
    return results
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
