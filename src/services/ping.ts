import type { ClaudeMessage } from "~/lib/translator"
import { authStore } from "~/services/auth/store"
import type { AuthProvider } from "~/services/auth/types"
import { createChatCompletionWithOptions } from "~/services/antigravity/chat"
import { accountManager } from "~/services/antigravity/account-manager"
import { fetchAntigravityModels } from "~/services/antigravity/quota-fetch"
import { createCodexCompletion } from "~/services/codex/chat"
import { createCopilotCompletion } from "~/services/copilot/chat"
import { createZedCompletion } from "~/services/zed/chat"
import { createKiroCompletion } from "~/services/kiro/chat"
import { createGrokCompletion } from "~/services/grok/chat"
import { getProviderModels } from "~/services/routing/models"
import { loadRoutingConfig } from "~/services/routing/config"
import { UpstreamError } from "~/lib/error"

const PING_MESSAGES: ClaudeMessage[] = [
    { role: "user", content: "ping" },
]

export async function pingAccount(
    provider: AuthProvider,
    accountId: string,
    modelId?: string
): Promise<{ modelId: string; latencyMs: number }> {
    const routingModels = getRoutingModelsForAccount(provider, accountId)
    const providerModels = getProviderModels(provider).map(model => model.id)
    const antigravityModels = provider === "antigravity"
        ? await getAntigravityPingCandidates(accountId)
        : []
    const candidates = [
        modelId,
        ...routingModels,
        ...antigravityModels,
        ...providerModels,
    ].filter(Boolean) as string[]
    const seen = new Set<string>()
    const uniqueCandidates = candidates.filter(id => {
        if (seen.has(id)) return false
        seen.add(id)
        return true
    })

    if (uniqueCandidates.length === 0) {
        throw new Error(`No models available for provider "${provider}"`)
    }

    const account = provider === "antigravity" ? null : authStore.getAccount(provider, accountId)
    if (provider !== "antigravity" && !account) {
        throw new Error(`Account not found: ${accountId}`)
    }

    let lastError: unknown = null
    const maxAttempts = Math.min(uniqueCandidates.length, provider === "antigravity" ? 10 : 4)

    for (let i = 0; i < maxAttempts; i++) {
        const targetModel = uniqueCandidates[i]
        const start = Date.now()
        try {
            if (provider === "antigravity") {
                await createChatCompletionWithOptions(
                    {
                        model: targetModel,
                        messages: PING_MESSAGES,
                        maxTokens: 8,
                        toolChoice: { type: "none" },
                    },
                    { accountId, allowRotation: false }
                )
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }

            if (provider === "codex") {
                await createCodexCompletion(account!, targetModel, PING_MESSAGES, undefined, 8)
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }

            if (provider === "copilot") {
                await createCopilotCompletion(account!, targetModel, PING_MESSAGES, undefined, 8)
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }

            if (provider === "zed") {
                await createZedCompletion(account!, targetModel, PING_MESSAGES, undefined, 8)
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }

            if (provider === "kiro") {
                await createKiroCompletion(account!, targetModel, PING_MESSAGES, undefined, 8)
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }

            if (provider === "grok") {
                await createGrokCompletion(account!, targetModel, PING_MESSAGES, undefined, 8)
                return { modelId: targetModel, latencyMs: Date.now() - start }
            }
        } catch (error) {
            lastError = error
            if (error instanceof UpstreamError && (error.status === 400 || error.status === 404)) {
                continue
            }
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new Error(`No reachable models for provider "${provider}"`)
}

function getRoutingModelsForAccount(provider: AuthProvider, accountId: string): string[] {
    const config = loadRoutingConfig()
    const models: string[] = []

    for (const flow of config.flows || []) {
        for (const entry of flow.entries || []) {
            if (entry.provider === provider && entry.accountId === accountId) {
                models.push(entry.modelId)
            }
        }
    }

    const accountRouting = config.accountRouting?.routes || []
    for (const route of accountRouting) {
        if (!route.modelId) continue
        const hasMatch = (route.entries || []).some(entry => entry.provider === provider && entry.accountId === accountId)
        if (hasMatch) {
            models.push(route.modelId)
        }
    }

    return models
}

async function getAntigravityPingCandidates(accountId: string): Promise<string[]> {
    const account = await accountManager.getAccountById(accountId)
    if (!account) return []

    try {
        const result = await fetchAntigravityModels(account.accessToken, account.projectId)
        const entries = Object.entries(result.models || {})
        if (entries.length === 0) return []

        const sorted = entries
            .sort((a, b) => (b[1]?.remainingFraction ?? 0) - (a[1]?.remainingFraction ?? 0))
            .map(([modelId]) => modelId)

        const withRemaining = sorted.filter((modelId) => {
            const remaining = result.models[modelId]?.remainingFraction ?? 0
            return remaining > 0
        })

        return withRemaining.length > 0 ? withRemaining : sorted
    } catch {
        return []
    }
}
