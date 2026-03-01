import { Hono } from "hono"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import { listCopilotModelsForAccount } from "~/services/copilot/chat"
import { listCodexModelsForAccount } from "~/services/codex/chat"
import { clearDynamicCodexModels, clearDynamicCopilotModels, getProviderModels, setDynamicCodexModels, setDynamicCopilotModels } from "~/services/routing/models"
import { loadRoutingConfig, saveRoutingConfig, setActiveFlow, type RoutingEntry, type RoutingFlow, type AccountRoutingConfig } from "~/services/routing/config"
import { accountManager } from "~/services/antigravity/account-manager"
import { getAggregatedQuota } from "~/services/quota-aggregator"
import { readFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import type { ProviderAccount, ProviderAccountSummary } from "~/services/auth/types"

export const routingRouter = new Hono()

const COPILOT_SYNC_TTL_MS = 60_000
const COPILOT_SYNC_TIMEOUT_MS = 800
const CODEX_SYNC_TTL_MS = 60_000
const CODEX_SYNC_TIMEOUT_MS = 800
const QUOTA_TIMEOUT_MS = 1200
const QUOTA_TTL_MS = 15_000

let lastCopilotSyncAt = 0
let copilotSyncInFlight: Promise<void> | null = null
let lastCodexSyncAt = 0
let codexSyncInFlight: Promise<void> | null = null
let lastQuotaSnapshot: Awaited<ReturnType<typeof getAggregatedQuota>> | null = null
let lastQuotaAt = 0
let quotaInFlight: Promise<Awaited<ReturnType<typeof getAggregatedQuota>> | null> | null = null

async function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ ok: boolean; value?: T; error?: Error; timedOut?: boolean }> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<{ ok: boolean; error: Error; timedOut: boolean }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ ok: false, error: new Error("timeout"), timedOut: true }), timeoutMs)
    })
    const result = await Promise.race([
        promise
            .then(value => ({ ok: true, value }))
            .catch(error => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })),
        timeoutPromise,
    ])
    if (timeoutId) clearTimeout(timeoutId)
    return result as { ok: boolean; value?: T; error?: Error; timedOut?: boolean }
}

function resolveAccountLabel(provider: "antigravity" | "codex" | "copilot", accountId: string, fallback?: string): string {
    if (accountId === "auto") return "auto"
    const account = authStore.getAccount(provider, accountId)
    return account?.label || account?.email || account?.login || fallback || accountId
}

function syncFlowLabels(flows: RoutingFlow[]): RoutingFlow[] {
    return flows.map(flow => ({
        ...flow,
        entries: flow.entries.map(entry => ({
            ...entry,
            accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
        })),
    }))
}

function syncAccountRoutingLabels(accountRouting?: AccountRoutingConfig): AccountRoutingConfig | undefined {
    if (!accountRouting) return accountRouting
    return {
        ...accountRouting,
        routes: accountRouting.routes.map(route => ({
            ...route,
            entries: route.entries.map(entry => ({
                ...entry,
                accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
            })),
        })),
    }
}

function listAccountsInOrder(provider: "antigravity" | "codex" | "copilot"): ProviderAccount[] {
    const accounts = authStore.listAccounts(provider)
    return accounts.sort((a, b) => {
        const aTime = a.createdAt || ""
        const bTime = b.createdAt || ""
        if (aTime && bTime) {
            return aTime.localeCompare(bTime)
        }
        if (aTime) return -1
        if (bTime) return 1
        return 0
    })
}

function toSummary(account: ProviderAccount): ProviderAccountSummary {
    return {
        id: account.id,
        provider: account.provider,
        displayName: account.label || account.email || account.login || account.id,
        email: account.email,
        login: account.login,
        label: account.label,
        expiresAt: account.expiresAt,
    }
}

routingRouter.get("/", (c) => {
    try {
        const htmlPath = join(import.meta.dir, "../../../public/routing.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch {
        return c.text("Routing panel not found", 404)
    }
})

routingRouter.get("/config", async (c) => {
    accountManager.load()
    const config = loadRoutingConfig()
    const syncedConfig = {
        ...config,
        flows: syncFlowLabels(config.flows),
        accountRouting: syncAccountRoutingLabels(config.accountRouting),
    }

    const antigravityAccounts = listAccountsInOrder("antigravity")
    const codexAccounts = listAccountsInOrder("codex")
    const copilotAccounts = listAccountsInOrder("copilot")

    const now = Date.now()
    if (copilotAccounts.length === 0) {
        clearDynamicCopilotModels()
        lastCopilotSyncAt = 0
    } else if (now - lastCopilotSyncAt > COPILOT_SYNC_TTL_MS) {
        if (!copilotSyncInFlight) {
            lastCopilotSyncAt = now
            copilotSyncInFlight = (async () => {
                let synced = false
                try {
                    for (const account of copilotAccounts) {
                        try {
                            const remoteModels = await listCopilotModelsForAccount(account)
                            if (remoteModels.length === 0) {
                                continue
                            }
                            const dynamicModels = remoteModels.map(model => ({
                                id: model.id,
                                label: `Copilot - ${model.name?.trim() || model.id}`,
                            }))
                            setDynamicCopilotModels(dynamicModels)
                            consola.debug(`[routing] Copilot models synced (${dynamicModels.length}) from ${account.id}`)
                            synced = true
                            break
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error)
                            consola.debug(`[routing] Copilot models sync skipped ${account.id}: ${message}`)
                        }
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    consola.warn(`[routing] Copilot models sync failed: ${message}`)
                } finally {
                    if (!synced) {
                        clearDynamicCopilotModels()
                        consola.debug("[routing] Copilot models sync unavailable; using static fallback")
                    }
                    copilotSyncInFlight = null
                }
            })()
        }
    }

    if (codexAccounts.length === 0) {
        clearDynamicCodexModels()
        lastCodexSyncAt = 0
    } else if (now - lastCodexSyncAt > CODEX_SYNC_TTL_MS) {
        if (!codexSyncInFlight) {
            lastCodexSyncAt = now
            codexSyncInFlight = (async () => {
                let synced = false
                try {
                    for (const account of codexAccounts) {
                        try {
                            const remoteModels = await listCodexModelsForAccount(account)
                            if (remoteModels.length === 0) {
                                continue
                            }
                            setDynamicCodexModels(remoteModels)
                            consola.debug(`[routing] Codex models synced (${remoteModels.length}) from ${account.id}`)
                            synced = true
                            break
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error)
                            consola.debug(`[routing] Codex models sync skipped ${account.id}: ${message}`)
                        }
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    consola.warn(`[routing] Codex models sync failed: ${message}`)
                } finally {
                    if (!synced) {
                        clearDynamicCodexModels()
                        consola.debug("[routing] Codex models sync unavailable; using static fallback")
                    }
                    codexSyncInFlight = null
                }
            })()
        }
    }

    const syncWaiters: Promise<unknown>[] = []
    if (copilotSyncInFlight) {
        syncWaiters.push(settleWithTimeout(copilotSyncInFlight, COPILOT_SYNC_TIMEOUT_MS))
    }
    if (codexSyncInFlight) {
        syncWaiters.push(settleWithTimeout(codexSyncInFlight, CODEX_SYNC_TIMEOUT_MS))
    }
    if (syncWaiters.length > 0) {
        await Promise.all(syncWaiters)
    }

    const accounts = {
        antigravity: antigravityAccounts.map(toSummary),
        codex: codexAccounts.map(toSummary),
        copilot: copilotAccounts.map(toSummary),
    }

    const models = {
        antigravity: getProviderModels("antigravity"),
        codex: getProviderModels("codex"),
        copilot: getProviderModels("copilot"),
    }

    // Get quota data for displaying on model blocks
    let quota: Awaited<ReturnType<typeof getAggregatedQuota>> | null = null
    const shouldFetchQuota = !lastQuotaSnapshot || now - lastQuotaAt > QUOTA_TTL_MS
    if (shouldFetchQuota && !quotaInFlight) {
        quotaInFlight = (async () => {
            try {
                const snapshot = await getAggregatedQuota()
                lastQuotaSnapshot = snapshot
                lastQuotaAt = Date.now()
                return snapshot
            } catch {
                return null
            } finally {
                quotaInFlight = null
            }
        })()
    }

    if (quotaInFlight) {
        const quotaResult = await settleWithTimeout(quotaInFlight, QUOTA_TIMEOUT_MS)
        if (quotaResult.ok && quotaResult.value) {
            quota = quotaResult.value
        } else {
            quota = lastQuotaSnapshot
        }
    } else {
        quota = lastQuotaSnapshot
    }

    return c.json({ config: syncedConfig, accounts, models, quota })
})

routingRouter.post("/config", async (c) => {
    const body = await c.req.json<{ flows?: RoutingFlow[]; entries?: RoutingEntry[]; accountRouting?: AccountRoutingConfig }>()
    let flows: RoutingFlow[] = []

    if (Array.isArray(body.flows)) {
        flows = body.flows
    } else if (Array.isArray(body.entries)) {
        flows = [{ id: randomUUID(), name: "default", entries: body.entries }]
    } else {
        const existing = loadRoutingConfig()
        flows = existing.flows
    }

    const normalized = flows.map((flow, index) => ({
        id: flow.id || randomUUID(),
        name: (flow.name || `Flow ${index + 1}`).trim() || `Flow ${index + 1}`,
        entries: Array.isArray(flow.entries)
            ? flow.entries.map(entry => ({
                ...entry,
                id: entry.id || randomUUID(),
                label: entry.label || `${entry.provider}:${entry.modelId}`,
                accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
            }))
            : [],
    }))

    let accountRouting: AccountRoutingConfig | undefined
    if (body.accountRouting) {
        accountRouting = {
            smartSwitch: body.accountRouting.smartSwitch ?? false,
            routes: Array.isArray(body.accountRouting.routes)
                ? body.accountRouting.routes.map(route => ({
                    id: route.id || randomUUID(),
                    modelId: (route.modelId || "").trim(),
                    entries: Array.isArray(route.entries)
                        ? route.entries.map(entry => ({
                            ...entry,
                            id: entry.id || randomUUID(),
                            accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
                        }))
                        : [],
                }))
                : [],
        }
    }

    const config = saveRoutingConfig(normalized, undefined, accountRouting)
    return c.json({ success: true, config })
})

// 🆕 设置/清除激活的 flow
routingRouter.post("/active-flow", async (c) => {
    const body = await c.req.json<{ flowId: string | null }>()
    const config = setActiveFlow(body.flowId)
    return c.json({ success: true, config })
})

// 🆕 清理孤立账号（已删除但仍在 routing 中的账号）
routingRouter.post("/cleanup", async (c) => {
    const config = loadRoutingConfig()

    // 获取所有有效账号
    const validAntigravity = new Set(authStore.listSummaries("antigravity").map(a => a.id || a.email))
    const validCodex = new Set(authStore.listSummaries("codex").map(a => a.id || a.email))
    const validCopilot = new Set(authStore.listSummaries("copilot").map(a => a.id || a.email))

    let removedCount = 0

    // 清理每个 flow 中的孤立 entries
    const cleanedFlows = config.flows.map(flow => ({
        ...flow,
        entries: flow.entries.filter(entry => {
            let isValid = false
            if (entry.provider === "antigravity") {
                isValid = entry.accountId === "auto" || validAntigravity.has(entry.accountId)
            } else if (entry.provider === "codex") {
                isValid = validCodex.has(entry.accountId)
            } else if (entry.provider === "copilot") {
                isValid = validCopilot.has(entry.accountId)
            }
            if (!isValid) {
                removedCount++
            }
            return isValid
        })
    }))

    // 清理 account routing 中的孤立 entries
    const cleanedAccountRouting = config.accountRouting ? {
        ...config.accountRouting,
        routes: config.accountRouting.routes.map(route => ({
            ...route,
            entries: route.entries.filter(entry => {
                let isValid = false
                if (entry.provider === "antigravity") {
                    isValid = entry.accountId === "auto" || validAntigravity.has(entry.accountId)
                } else if (entry.provider === "codex") {
                    isValid = validCodex.has(entry.accountId)
                } else if (entry.provider === "copilot") {
                    isValid = validCopilot.has(entry.accountId)
                }
                if (!isValid) {
                    removedCount++
                }
                return isValid
            })
        }))
    } : config.accountRouting

    // 保存清理后的配置
    const newConfig = saveRoutingConfig(cleanedFlows, undefined, cleanedAccountRouting)

    // 同时清理 account-manager 的 rate limit 状态
    accountManager.clearAllRateLimits()

    return c.json({
        success: true,
        removedCount,
        config: newConfig
    })
})
