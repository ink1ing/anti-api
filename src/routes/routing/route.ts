import { Hono } from "hono"
import { authStore } from "~/services/auth/store"
import { getProviderModels } from "~/services/routing/models"
import { loadRoutingConfig, saveRoutingConfig, setActiveFlow, type RoutingEntry, type RoutingFlow, type AccountRoutingConfig } from "~/services/routing/config"
import { accountManager } from "~/services/antigravity/account-manager"
import { getAggregatedQuota } from "~/services/quota-aggregator"
import { readFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import type { ProviderAccountSummary } from "~/services/auth/types"

export const routingRouter = new Hono()

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

    const listSummariesInOrder = (provider: "antigravity" | "codex" | "copilot"): ProviderAccountSummary[] => {
        const accounts = authStore.listAccounts(provider)
        const sorted = accounts.sort((a, b) => {
            const aTime = a.createdAt || ""
            const bTime = b.createdAt || ""
            if (aTime && bTime) {
                return aTime.localeCompare(bTime)
            }
            if (aTime) return -1
            if (bTime) return 1
            return 0
        })
        return sorted.map(acc => ({
            id: acc.id,
            provider: acc.provider,
            displayName: acc.label || acc.email || acc.login || acc.id,
            email: acc.email,
            login: acc.login,
            label: acc.label,
            expiresAt: acc.expiresAt,
        }))
    }

    const accounts = {
        antigravity: listSummariesInOrder("antigravity"),
        codex: listSummariesInOrder("codex"),
        copilot: listSummariesInOrder("copilot"),
    }

    const models = {
        antigravity: getProviderModels("antigravity"),
        codex: getProviderModels("codex"),
        copilot: getProviderModels("copilot"),
    }

    // Get quota data for displaying on model blocks
    let quota: Awaited<ReturnType<typeof getAggregatedQuota>> | null = null
    try {
        quota = await getAggregatedQuota()
    } catch {
        // Quota fetch is optional, continue without it
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
