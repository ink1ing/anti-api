import { Hono } from "hono"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import { listCopilotModelsForAccount } from "~/services/copilot/chat"
import { listCodexModelsForAccount } from "~/services/codex/chat"
import { fetchAntigravityModels } from "~/services/antigravity/quota-fetch"
import { listZedModelsForAccount } from "~/services/zed/chat"
import { listKiroModelsForAccount } from "~/services/kiro/chat"
import {
    clearAllDynamicCodexModelsByAccount,
    clearAllDynamicCopilotModelsByAccount,
    clearAllDynamicAntigravityModelsByAccount,
    clearAllDynamicZedModelsByAccount,
    clearAllDynamicKiroModelsByAccount,
    clearDynamicAntigravityModels,
    clearDynamicAntigravityModelsForAccount,
    clearDynamicCodexModels,
    clearDynamicCodexModelsForAccount,
    clearDynamicCopilotModels,
    clearDynamicCopilotModelsForAccount,
    clearDynamicZedModels,
    clearDynamicZedModelsForAccount,
    clearDynamicKiroModels,
    clearDynamicKiroModelsForAccount,
    getProviderModels,
    getProviderModelsForAccount,
    setDynamicAntigravityModels,
    setDynamicAntigravityModelsForAccount,
    setDynamicCodexModels,
    setDynamicCodexModelsForAccount,
    setDynamicCopilotModels,
    setDynamicCopilotModelsForAccount,
    setDynamicZedModels,
    setDynamicZedModelsForAccount,
    setDynamicKiroModels,
    setDynamicKiroModelsForAccount,
    type ProviderModelOption,
} from "~/services/routing/models"
import { loadRoutingConfig, saveRoutingConfig, setActiveFlow, type RoutingEntry, type RoutingFlow, type AccountRoutingConfig } from "~/services/routing/config"
import { accountManager } from "~/services/antigravity/account-manager"
import { getAggregatedQuota } from "~/services/quota-aggregator"
import { readFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import type { ProviderAccount, ProviderAccountSummary } from "~/services/auth/types"
import { getPublicDir } from "~/lib/public-dir"

export const routingRouter = new Hono()

const COPILOT_SYNC_TTL_MS = 60_000
const COPILOT_SYNC_TIMEOUT_MS = 800
const CODEX_SYNC_TTL_MS = 60_000
const CODEX_SYNC_TIMEOUT_MS = 800
const ANTIGRAVITY_SYNC_TTL_MS = 60_000
const ANTIGRAVITY_SYNC_TIMEOUT_MS = 800
const ZED_SYNC_TTL_MS = 60_000
const ZED_SYNC_TIMEOUT_MS = 800
const KIRO_SYNC_TTL_MS = 60_000
const KIRO_SYNC_TIMEOUT_MS = 800
const QUOTA_TIMEOUT_MS = 1200
const QUOTA_TTL_MS = 15_000

let lastCopilotSyncAt = 0
let copilotSyncInFlight: Promise<void> | null = null
let lastCodexSyncAt = 0
let codexSyncInFlight: Promise<void> | null = null
let lastAntigravitySyncAt = 0
let antigravitySyncInFlight: Promise<void> | null = null
let lastZedSyncAt = 0
let zedSyncInFlight: Promise<void> | null = null
let lastKiroSyncAt = 0
let kiroSyncInFlight: Promise<void> | null = null
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

function resolveAccountLabel(provider: "antigravity" | "codex" | "copilot" | "zed" | "kiro" | "grok", accountId: string, fallback?: string): string {
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

function listAccountsInOrder(provider: "antigravity" | "codex" | "copilot" | "zed" | "kiro" | "grok"): ProviderAccount[] {
    let accounts: ProviderAccount[] = []
    try {
        accounts = authStore.listAccounts(provider) || []
    } catch {
        accounts = []
    }
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

function normalizeRemoteModels(prefix: string, models: Array<{ id?: string; name?: string }>): ProviderModelOption[] {
    const merged = new Map<string, ProviderModelOption>()
    for (const model of models) {
        const id = model.id?.trim()
        if (!id || merged.has(id)) continue
        merged.set(id, { id, label: `${prefix} - ${model.name?.trim() || id}` })
    }
    return Array.from(merged.values())
}

routingRouter.get("/", (c) => {
    try {
        const htmlPath = join(getPublicDir(import.meta.dir, "../../../public"), "routing.html")
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
    const zedAccounts = listAccountsInOrder("zed")
    const kiroAccounts = listAccountsInOrder("kiro")

    const now = Date.now()
    if (copilotAccounts.length === 0) {
        clearDynamicCopilotModels()
        clearAllDynamicCopilotModelsByAccount()
        lastCopilotSyncAt = 0
    } else if (now - lastCopilotSyncAt > COPILOT_SYNC_TTL_MS) {
        if (!copilotSyncInFlight) {
            lastCopilotSyncAt = now
            copilotSyncInFlight = (async () => {
                const mergedModels = new Map<string, ProviderModelOption>()
                try {
                    for (const account of copilotAccounts) {
                        try {
                            const remoteModels = await listCopilotModelsForAccount(account)
                            const dynamicModels = normalizeRemoteModels("Copilot", remoteModels)
                            if (dynamicModels.length === 0) {
                                clearDynamicCopilotModelsForAccount(account.id)
                                continue
                            }
                            setDynamicCopilotModelsForAccount(account.id, dynamicModels)
                            for (const model of dynamicModels) {
                                if (!mergedModels.has(model.id)) mergedModels.set(model.id, model)
                            }
                            consola.debug(`[routing] Copilot models synced (${dynamicModels.length}) from ${account.id}`)
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error)
                            clearDynamicCopilotModelsForAccount(account.id)
                            consola.debug(`[routing] Copilot models sync skipped ${account.id}: ${message}`)
                        }
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    consola.warn(`[routing] Copilot models sync failed: ${message}`)
                } finally {
                    if (mergedModels.size > 0) {
                        setDynamicCopilotModels(Array.from(mergedModels.values()))
                    } else {
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
        clearAllDynamicCodexModelsByAccount()
        lastCodexSyncAt = 0
    } else if (now - lastCodexSyncAt > CODEX_SYNC_TTL_MS) {
        if (!codexSyncInFlight) {
            lastCodexSyncAt = now
            codexSyncInFlight = (async () => {
                const mergedModels = new Map<string, ProviderModelOption>()
                try {
                    for (const account of codexAccounts) {
                        try {
                            const remoteModels = await listCodexModelsForAccount(account)
                            if (remoteModels.length === 0) {
                                clearDynamicCodexModelsForAccount(account.id)
                                continue
                            }
                            setDynamicCodexModelsForAccount(account.id, remoteModels)
                            for (const model of remoteModels) {
                                if (!mergedModels.has(model.id)) mergedModels.set(model.id, model)
                            }
                            consola.debug(`[routing] Codex models synced (${remoteModels.length}) from ${account.id}`)
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error)
                            clearDynamicCodexModelsForAccount(account.id)
                            consola.debug(`[routing] Codex models sync skipped ${account.id}: ${message}`)
                        }
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    consola.warn(`[routing] Codex models sync failed: ${message}`)
                } finally {
                    if (mergedModels.size > 0) {
                        setDynamicCodexModels(Array.from(mergedModels.values()))
                    } else {
                        clearDynamicCodexModels()
                        consola.debug("[routing] Codex models sync unavailable; using static fallback")
                    }
                    codexSyncInFlight = null
                }
            })()
        }
    }

    if (antigravityAccounts.length === 0) {
        clearDynamicAntigravityModels()
        clearAllDynamicAntigravityModelsByAccount()
        lastAntigravitySyncAt = 0
    } else if (now - lastAntigravitySyncAt > ANTIGRAVITY_SYNC_TTL_MS) {
        if (!antigravitySyncInFlight) {
            lastAntigravitySyncAt = now
            antigravitySyncInFlight = (async () => {
                const [primaryAccount] = antigravityAccounts
                if (!primaryAccount) {
                    clearDynamicAntigravityModels()
                    antigravitySyncInFlight = null
                    return
                }
                try {
                    const active = await accountManager.getAccountById(primaryAccount.id)
                    if (!active) {
                        clearDynamicAntigravityModelsForAccount(primaryAccount.id)
                        clearDynamicAntigravityModels()
                        antigravitySyncInFlight = null
                        return
                    }
                    const remote = await fetchAntigravityModels(active.accessToken, active.projectId)
                    const models = Object.keys(remote.models || {}).map((id) => ({
                        id,
                        label: `Antigravity - ${id}`,
                    }))
                    if (models.length > 0) {
                        setDynamicAntigravityModelsForAccount(primaryAccount.id, models)
                        setDynamicAntigravityModels(models)
                        consola.debug(`[routing] Antigravity models synced (${models.length}) from ${primaryAccount.id}`)
                    } else {
                        clearDynamicAntigravityModelsForAccount(primaryAccount.id)
                        clearDynamicAntigravityModels()
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    clearDynamicAntigravityModelsForAccount(primaryAccount.id)
                    clearDynamicAntigravityModels()
                    consola.debug(`[routing] Antigravity models sync skipped ${primaryAccount.id}: ${message}`)
                } finally {
                    antigravitySyncInFlight = null
                }
            })()
        }
    }

    if (zedAccounts.length === 0) {
        clearDynamicZedModels()
        clearAllDynamicZedModelsByAccount()
        lastZedSyncAt = 0
    } else if (now - lastZedSyncAt > ZED_SYNC_TTL_MS) {
        if (!zedSyncInFlight) {
            lastZedSyncAt = now
            zedSyncInFlight = (async () => {
                const mergedModels = new Map<string, ProviderModelOption>()
                try {
                    for (const account of zedAccounts) {
                        try {
                            const remoteModels = await listZedModelsForAccount(account)
                            const dynamicModels = normalizeRemoteModels("Zed", remoteModels.map(model => ({
                                id: model.id,
                                name: model.display_name || model.id,
                            })))
                            if (dynamicModels.length === 0) {
                                clearDynamicZedModelsForAccount(account.id)
                                continue
                            }
                            setDynamicZedModelsForAccount(account.id, dynamicModels)
                            for (const model of dynamicModels) {
                                if (!mergedModels.has(model.id)) mergedModels.set(model.id, model)
                            }
                            consola.debug(`[routing] Zed models synced (${dynamicModels.length}) from ${account.id}`)
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error)
                            clearDynamicZedModelsForAccount(account.id)
                            consola.debug(`[routing] Zed models sync skipped ${account.id}: ${message}`)
                        }
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    consola.warn(`[routing] Zed models sync failed: ${message}`)
                } finally {
                    if (mergedModels.size > 0) {
                        setDynamicZedModels(Array.from(mergedModels.values()))
                    } else {
                        clearDynamicZedModels()
                    }
                    zedSyncInFlight = null
                }
            })()
        }
    }

    if (kiroAccounts.length === 0) {
        clearDynamicKiroModels()
        clearAllDynamicKiroModelsByAccount()
        lastKiroSyncAt = 0
    } else if (now - lastKiroSyncAt > KIRO_SYNC_TTL_MS) {
        if (!kiroSyncInFlight) {
            lastKiroSyncAt = now
            kiroSyncInFlight = (async () => {
                const mergedModels = new Map<string, ProviderModelOption>()
                try {
                    for (const account of kiroAccounts) {
                        try {
                            const remoteModels = await listKiroModelsForAccount(account)
                            const dynamicModels = normalizeRemoteModels("Kiro", remoteModels)
                            if (dynamicModels.length === 0) {
                                clearDynamicKiroModelsForAccount(account.id)
                                continue
                            }
                            setDynamicKiroModelsForAccount(account.id, dynamicModels)
                            for (const model of dynamicModels) {
                                if (!mergedModels.has(model.id)) mergedModels.set(model.id, model)
                            }
                            consola.debug(`[routing] Kiro models synced (${dynamicModels.length}) from ${account.id}`)
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error)
                            clearDynamicKiroModelsForAccount(account.id)
                            consola.debug(`[routing] Kiro models sync skipped ${account.id}: ${message}`)
                        }
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    consola.warn(`[routing] Kiro models sync failed: ${message}`)
                } finally {
                    if (mergedModels.size > 0) {
                        setDynamicKiroModels(Array.from(mergedModels.values()))
                    } else {
                        clearDynamicKiroModels()
                    }
                    kiroSyncInFlight = null
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
    if (antigravitySyncInFlight) {
        syncWaiters.push(settleWithTimeout(antigravitySyncInFlight, ANTIGRAVITY_SYNC_TIMEOUT_MS))
    }
    if (zedSyncInFlight) {
        syncWaiters.push(settleWithTimeout(zedSyncInFlight, ZED_SYNC_TIMEOUT_MS))
    }
    if (kiroSyncInFlight) {
        syncWaiters.push(settleWithTimeout(kiroSyncInFlight, KIRO_SYNC_TIMEOUT_MS))
    }
    if (syncWaiters.length > 0) {
        await Promise.all(syncWaiters)
    }

    const accounts = {
        antigravity: antigravityAccounts.map(toSummary),
        codex: codexAccounts.map(toSummary),
        copilot: copilotAccounts.map(toSummary),
        zed: zedAccounts.map(toSummary),
        kiro: kiroAccounts.map(toSummary),
    }

    const models = {
        antigravity: getProviderModels("antigravity"),
        codex: getProviderModels("codex"),
        copilot: getProviderModels("copilot"),
        zed: getProviderModels("zed"),
        kiro: getProviderModels("kiro"),
    }

    const accountModels = {
        antigravity: Object.fromEntries(antigravityAccounts.map(account => [account.id, getProviderModelsForAccount("antigravity", account.id)])),
        codex: Object.fromEntries(codexAccounts.map(account => [account.id, getProviderModelsForAccount("codex", account.id)])),
        copilot: Object.fromEntries(copilotAccounts.map(account => [account.id, getProviderModelsForAccount("copilot", account.id)])),
        zed: Object.fromEntries(zedAccounts.map(account => [account.id, getProviderModelsForAccount("zed", account.id)])),
        kiro: Object.fromEntries(kiroAccounts.map(account => [account.id, getProviderModelsForAccount("kiro", account.id)])),
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

    return c.json({ config: syncedConfig, accounts, models, accountModels, quota })
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
    const validZed = new Set(authStore.listSummaries("zed").map(a => a.id || a.email))
    const validKiro = new Set(authStore.listSummaries("kiro").map(a => a.id || a.email))

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
            } else if (entry.provider === "zed") {
                isValid = validZed.has(entry.accountId)
            } else if (entry.provider === "kiro") {
                isValid = validKiro.has(entry.accountId)
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
                } else if (entry.provider === "zed") {
                    isValid = validZed.has(entry.accountId)
                } else if (entry.provider === "kiro") {
                    isValid = validKiro.has(entry.accountId)
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
