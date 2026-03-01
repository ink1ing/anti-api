import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { UpstreamError } from "~/lib/error"
import type { RoutingConfig } from "~/services/routing/config"

let currentConfig: RoutingConfig = {
    version: 2,
    updatedAt: new Date().toISOString(),
    flows: [],
    accountRouting: { smartSwitch: false, routes: [] },
}

let rateLimitMarkCalls = 0
let upstreamStatus = 404
let upstreamBody = "not found"

mock.module("~/services/routing/config", () => ({
    loadRoutingConfig: () => currentConfig,
}))

mock.module("~/services/antigravity/chat", () => ({
    createChatCompletionWithOptions: async () => {
        throw new UpstreamError("antigravity", upstreamStatus, upstreamBody)
    },
    createChatCompletionStreamWithOptions: async function* () {
        throw new UpstreamError("antigravity", upstreamStatus, upstreamBody)
    },
}))

mock.module("~/services/antigravity/account-manager", () => ({
    accountManager: {
        load: () => { },
        hasAccount: () => true,
        count: () => 1,
        getAccountById: async (accountId: string) => ({ accountId, accessToken: "token", projectId: "p", email: accountId }),
        getNextAvailableAccount: async () => ({ accountId: "acc-1", accessToken: "token", projectId: "p", email: "acc-1" }),
        acquireAccountLock: async () => () => { },
        markSuccess: () => { },
        markRateLimited: () => { },
        moveToEndOfQueue: () => { },
        isAccountRateLimited: () => false,
        isAccountInFlight: () => false,
        markRateLimitedFromError: async () => {
            rateLimitMarkCalls += 1
            return { reason: "unknown", durationMs: 30_000 }
        },
        clearAllRateLimits: () => { },
    },
}))

mock.module("~/services/codex/chat", () => ({
    createCodexCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    isCodexModelSupportedForAccount: () => undefined,
    isCodexUnsupportedModelError: () => false,
}))

mock.module("~/services/copilot/chat", () => ({
    createCopilotCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
}))

mock.module("~/services/auth/store", () => ({
    authStore: {
        getAccount: () => null,
        isRateLimited: () => false,
        markRateLimited: () => 1_000,
        markSuccess: () => { },
        listAccounts: () => [],
    },
}))

async function getRouter() {
    return await import(`../src/services/routing/router.ts?${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
    rateLimitMarkCalls = 0
    upstreamStatus = 404
    upstreamBody = "not found"
})

afterAll(() => {
    mock.restore()
})

test("flow routing does not mark antigravity account rate-limited on upstream 404", async () => {
    currentConfig = {
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [
            {
                id: "flow-404",
                name: "flow-404",
                entries: [
                    { id: "e1", provider: "antigravity", accountId: "acc-1", modelId: "claude-opus-4-6-thinking", label: "A1" },
                ],
            },
        ],
        accountRouting: { smartSwitch: false, routes: [] },
    }

    const router = await getRouter()
    await expect(router.createRoutedCompletion({ model: "flow-404", messages: [{ role: "user", content: "hi" }] }))
        .rejects.toMatchObject({ status: 404 })
    expect(rateLimitMarkCalls).toBe(0)
})

test("account routing does not mark antigravity account rate-limited on upstream 404", async () => {
    currentConfig = {
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [],
        accountRouting: {
            smartSwitch: false,
            routes: [
                {
                    id: "r1",
                    modelId: "claude-opus-4-6-thinking",
                    entries: [{ id: "a1", provider: "antigravity", accountId: "acc-1" }],
                },
            ],
        },
    }

    const router = await getRouter()
    await expect(router.createRoutedCompletion({ model: "claude-opus-4-6-thinking", messages: [{ role: "user", content: "hi" }] }))
        .rejects.toMatchObject({ status: 404 })
    expect(rateLimitMarkCalls).toBe(0)
})

test("account routing does not mark antigravity account rate-limited on upstream 403", async () => {
    upstreamStatus = 403
    upstreamBody = "permission denied"

    currentConfig = {
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [],
        accountRouting: {
            smartSwitch: false,
            routes: [
                {
                    id: "r2",
                    modelId: "claude-opus-4-6-thinking",
                    entries: [{ id: "a2", provider: "antigravity", accountId: "acc-1" }],
                },
            ],
        },
    }

    const router = await getRouter()
    await expect(router.createRoutedCompletion({ model: "claude-opus-4-6-thinking", messages: [{ role: "user", content: "hi" }] }))
        .rejects.toMatchObject({ status: 403 })
    expect(rateLimitMarkCalls).toBe(0)
})
