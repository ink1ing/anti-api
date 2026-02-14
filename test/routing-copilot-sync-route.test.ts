import { beforeEach, expect, mock, test } from "bun:test"
import { clearDynamicCopilotModels } from "~/services/routing/models"
import type { ProviderAccount } from "~/services/auth/types"

type Provider = "antigravity" | "codex" | "copilot"

const accountsByProvider: Record<Provider, ProviderAccount[]> = {
    antigravity: [],
    codex: [],
    copilot: [],
}

let syncMode: "success" | "error" = "success"
let remoteModels: Array<{ id: string; name?: string; model_picker_enabled?: boolean }> = []
const syncedWithAccountIds: string[] = []

mock.module("~/services/auth/store", () => ({
    authStore: {
        listAccounts: (provider?: Provider) => {
            if (!provider) {
                return [...accountsByProvider.antigravity, ...accountsByProvider.codex, ...accountsByProvider.copilot]
            }
            return [...accountsByProvider[provider]]
        },
        listSummaries: (provider?: Provider) => {
            const accounts = provider
                ? accountsByProvider[provider]
                : [...accountsByProvider.antigravity, ...accountsByProvider.codex, ...accountsByProvider.copilot]
            return accounts.map(account => ({
                id: account.id,
                provider: account.provider,
                displayName: account.label || account.email || account.login || account.id,
                email: account.email,
                login: account.login,
                label: account.label,
                expiresAt: account.expiresAt,
            }))
        },
        getAccount: (provider: Provider, id: string) => {
            return accountsByProvider[provider].find(account => account.id === id) || null
        },
    },
}))

mock.module("~/services/routing/config", () => ({
    loadRoutingConfig: () => ({
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [],
        accountRouting: { smartSwitch: false, routes: [] },
    }),
    saveRoutingConfig: () => ({
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [],
        accountRouting: { smartSwitch: false, routes: [] },
    }),
    setActiveFlow: () => ({
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [],
        accountRouting: { smartSwitch: false, routes: [] },
    }),
}))

mock.module("~/services/antigravity/account-manager", () => ({
    accountManager: {
        load: () => { },
        clearAllRateLimits: () => { },
        hasAccount: () => true,
    },
}))

mock.module("~/services/quota-aggregator", () => ({
    getAggregatedQuota: async () => null,
}))

mock.module("~/services/copilot/chat", () => ({
    createCopilotCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    listCopilotModelsForAccount: async (account: ProviderAccount) => {
        syncedWithAccountIds.push(account.id)
        if (syncMode === "error") {
            throw new Error("sync failed")
        }
        return remoteModels
    },
}))

const routingRouterPromise = import(`../src/routes/routing/route.ts?${Date.now()}-${Math.random()}`).then(mod => mod.routingRouter)

function addCopilotAccount(id: string, createdAt: string): void {
    accountsByProvider.copilot.push({
        id,
        provider: "copilot",
        accessToken: `token-${id}`,
        login: id,
        createdAt,
    })
}

beforeEach(() => {
    accountsByProvider.antigravity = []
    accountsByProvider.codex = []
    accountsByProvider.copilot = []
    syncedWithAccountIds.length = 0
    syncMode = "success"
    remoteModels = []
    clearDynamicCopilotModels()
})

test("routing config syncs copilot models from the first available account", async () => {
    addCopilotAccount("older-account", "2026-01-01T00:00:00.000Z")
    addCopilotAccount("newer-account", "2026-01-02T00:00:00.000Z")
    remoteModels = [{ id: "gpt-5.2", name: "GPT-5.2", model_picker_enabled: true }]

    const routingRouter = await routingRouterPromise
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(syncedWithAccountIds[0]).toBe("older-account")
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-5.2")).toBe(true)
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-4o")).toBe(true)
})

test("routing config keeps static copilot models when dynamic sync fails", async () => {
    addCopilotAccount("copilot-1", "2026-01-01T00:00:00.000Z")
    syncMode = "error"

    const routingRouter = await routingRouterPromise
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(syncedWithAccountIds.length).toBe(1)
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-4o")).toBe(true)
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-5.2")).toBe(false)
})

test("routing config falls back to static copilot models when no copilot account exists", async () => {
    const routingRouter = await routingRouterPromise
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(syncedWithAccountIds.length).toBe(0)
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-4o")).toBe(true)
})
