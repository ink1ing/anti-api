import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { UpstreamError } from "~/lib/error"
import { createChatCompletionWithOptions, createChatCompletionStreamWithOptions } from "~/services/antigravity/chat"
import { generateImages } from "~/services/antigravity/image-generation"
import { accountManager } from "~/services/antigravity/account-manager"
import { createCodexCompletion } from "~/services/codex/chat"
import { createCopilotCompletion } from "~/services/copilot/chat"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import { loadRoutingConfig, isAccountDisabled, type RoutingEntry, type RoutingConfig, type AccountRoutingEntry } from "./config"
import { getProviderModels, isHiddenCodexModel } from "./models"
import { buildMessageStart, buildContentBlockStart, buildTextDelta, buildInputJsonDelta, buildContentBlockStop, buildMessageDelta, buildMessageStop } from "~/lib/translator"
import { formatLogTime, setRequestLogContext } from "~/lib/logger"
import type { AuthProvider } from "~/services/auth/types"
import { recordUsage } from "~/services/usage-tracker"
import { getAccountModelQuotaPercent } from "~/services/quota-aggregator"
import { getSetting } from "~/services/settings"
import { normalizeModelName } from "./model-aliases"

export class RoutingError extends Error {
    status: number
    constructor(message: string, status: number = 400) {
        super(message)
        this.name = "RoutingError"
        this.status = status
    }
}

interface RoutedRequest {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    toolChoice?: {
        type: "auto" | "any" | "tool" | "none"
        name?: string
    }
    maxTokens?: number
}

type FlowStickyState = {
    cursor: number
    lastProbeAt?: number
}
type AccountStickyState = {
    cursor: number
}

type ProviderUsage = {
    usage?: {
        inputTokens?: number
        outputTokens?: number
    }
}

function isEntryUsable(entry: RoutingEntry): boolean {
    if (entry.provider === "antigravity") {
        return true
    }
    return !!authStore.getAccount(entry.provider, entry.accountId)
}

// 🆕 Router 级别的 rate-limit 状态（独立于 accountManager）
const routerRateLimits = new Map<string, number>()  // "provider:accountId" -> expiry timestamp
// 🆕 Router 级别的配额缓存（5秒 TTL，减少配额检查开销）
const routerQuotaCache = new Map<string, { percent: number | null; expiry: number }>()
const ROUTER_QUOTA_CACHE_TTL = 5000 // 5秒
// 🆕 配额黑名单（5分钟，避免重复检查 0% 配额账户）
const quotaBlacklist = new Map<string, number>() // "provider:accountId:model" -> expiry
const QUOTA_BLACKLIST_DURATION = 5 * 60 * 1000 // 5分钟

const PROVIDER_ORDER: AuthProvider[] = ["antigravity", "codex", "copilot"]
let officialModelIndex: Map<string, Set<AuthProvider>> | null = null
const flowStickyStates = new Map<string, FlowStickyState>()
const accountStickyStates = new Map<string, AccountStickyState>()

function getRouterRateLimitKey(provider: string, accountId: string): string {
    return `${provider}:${accountId}`
}

function isRouterRateLimited(provider: string, accountId: string): boolean {
    const key = getRouterRateLimitKey(provider, accountId)
    const expiry = routerRateLimits.get(key)
    if (!expiry) return false
    if (Date.now() > expiry) {
        routerRateLimits.delete(key)
        return false
    }
    return true
}

function markRouterRateLimited(provider: string, accountId: string, durationMs: number = 30000): void {
    const key = getRouterRateLimitKey(provider, accountId)
    routerRateLimits.set(key, Date.now() + durationMs)
}

function getQuotaCachedPercent(provider: string, accountId: string, model: string): number | null {
    const key = `${provider}:${accountId}:${model}`
    const cached = routerQuotaCache.get(key)
    if (cached && Date.now() < cached.expiry) {
        return cached.percent
    }
    const percent = getAccountModelQuotaPercent(provider as any, accountId, model)
    routerQuotaCache.set(key, { percent, expiry: Date.now() + ROUTER_QUOTA_CACHE_TTL })
    return percent
}

function isQuotaBlacklisted(provider: string, accountId: string, model: string): boolean {
    const key = `${provider}:${accountId}:${model}`
    const expiry = quotaBlacklist.get(key)
    if (!expiry) return false
    if (Date.now() > expiry) {
        quotaBlacklist.delete(key)
        return false
    }
    return true
}

function addToQuotaBlacklist(provider: string, accountId: string, model: string): void {
    const key = `${provider}:${accountId}:${model}`
    quotaBlacklist.set(key, Date.now() + QUOTA_BLACKLIST_DURATION)
}

function getFlowStickyState(flowKey: string, entriesLength: number): FlowStickyState {
    const existing = flowStickyStates.get(flowKey)
    if (!existing) {
        const state = { cursor: 0 }
        flowStickyStates.set(flowKey, state)
        return state
    }
    if (existing.cursor < 0 || existing.cursor >= entriesLength) {
        existing.cursor = 0
    }
    return existing
}

function getAccountStickyState(model: string, entriesLength: number): AccountStickyState {
    const key = model || ""
    const existing = accountStickyStates.get(key)
    if (!existing) {
        const state = { cursor: 0 }
        accountStickyStates.set(key, state)
        return state
    }
    if (existing.cursor < 0 || existing.cursor >= entriesLength) {
        existing.cursor = 0
    }
    return existing
}

function advanceAccountCursor(state: AccountStickyState | null, entriesLength: number, currentIndex: number): void {
    if (!state || entriesLength <= 1) return
    state.cursor = (currentIndex + 1) % entriesLength
}

function buildOfficialModelIndex(): Map<string, Set<AuthProvider>> {
    const index = new Map<string, Set<AuthProvider>>()
    for (const provider of PROVIDER_ORDER) {
        const models = getProviderModels(provider)
        for (const model of models) {
            const key = model.id
            if (!index.has(key)) {
                index.set(key, new Set<AuthProvider>())
            }
            index.get(key)!.add(provider)
        }
    }
    return index
}

function getOfficialModelProviders(model: string): AuthProvider[] {
    if (!officialModelIndex) {
        officialModelIndex = buildOfficialModelIndex()
    }
    return Array.from(officialModelIndex.get(model) || [])
}

function isOfficialModel(model: string): boolean {
    return getOfficialModelProviders(model).length > 0
}

function normalizeEntries(entries: RoutingEntry[]): RoutingEntry[] {
    return entries.filter(entry => {
        if (entry.provider === "codex" && isHiddenCodexModel(entry.modelId)) {
            return false
        }
        if (!isEntryUsable(entry)) return false
        // 🆕 Antigravity 账号需检查是否存在于 accountManager
        if (entry.provider === "antigravity" && entry.accountId !== "auto") {
            if (!accountManager.hasAccount(entry.accountId)) {
                return false
            }
        }
        return true
    })
}

function listProviderAccountsInOrder(provider: AuthProvider): ProviderAccount[] {
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

function buildAutoEntriesForProvider(provider: AuthProvider): AccountRoutingEntry[] {
    const accounts = listProviderAccountsInOrder(provider)
    return accounts.map(account => ({
        id: crypto.randomUUID(),
        provider,
        accountId: account.id,
        accountLabel: account.label || account.email || account.login || account.id,
    }))
}

function resolveAccountRoutingEntries(config: RoutingConfig, model: string): AccountRoutingEntry[] {
    const providers = getOfficialModelProviders(model)
    if (providers.length === 0) {
        throw new RoutingError(`Model "${model}" is not an official model`, 400)
    }

    const accountRouting = config.accountRouting
    const smartSwitch = accountRouting?.smartSwitch ?? false
    const route = accountRouting?.routes.find(r => r.modelId === model)

    let entries: AccountRoutingEntry[] = route?.entries ? [...route.entries] : []

    if (entries.length === 0) {
        if (!smartSwitch) {
            throw new RoutingError(`No account routing configured for model "${model}"`, 400)
        }
        entries = providers.flatMap(provider => buildAutoEntriesForProvider(provider))
    } else {
        const expanded: AccountRoutingEntry[] = []
        for (const entry of entries) {
            if (entry.accountId === "auto") {
                if (!smartSwitch) {
                    throw new RoutingError(`Account routing for "${model}" includes auto entries but smart switch is disabled`, 400)
                }
                expanded.push(...buildAutoEntriesForProvider(entry.provider))
                continue
            }
            expanded.push(entry)
        }
        entries = expanded
    }

    let filtered = entries.filter(entry => providers.includes(entry.provider))

    let valid = filtered.filter(entry => {
        if (!isEntryUsable(entry as RoutingEntry)) return false
        if (entry.provider === "antigravity" && entry.accountId !== "auto") {
            return accountManager.hasAccount(entry.accountId)
        }
        return true
    })

    if (valid.length === 0 && smartSwitch) {
        filtered = providers.flatMap(provider => buildAutoEntriesForProvider(provider))
        valid = filtered.filter(entry => {
            if (!isEntryUsable(entry as RoutingEntry)) return false
            if (entry.provider === "antigravity" && entry.accountId !== "auto") {
                return accountManager.hasAccount(entry.accountId)
            }
            return true
        })
    }

    if (valid.length === 0) {
        throw new RoutingError(`No valid account routing entries for model "${model}"`, 400)
    }

    return valid
}

function getAccountDisplay(provider: AuthProvider, accountId: string): string {
    const account = authStore.getAccount(provider, accountId)
    return account?.login || account?.email || account?.label || accountId
}

const FALLBACK_STATUSES = new Set([401, 403, 408, 429, 500, 503, 529])
const FLOW_PROBE_INTERVAL_MS = 30_000

function isAccountUnavailableError(error: unknown): boolean {
    if (error instanceof UpstreamError) {
        if (error.status !== 429) return false
        const body = (error.body || "").trim()
        if (body.startsWith("Account unavailable:")) return true
    }
    if (!(error instanceof Error)) return false
    if (error.message.startsWith("Account not found:")) return true
    if (error.message.startsWith("Account unavailable:")) return true
    return false
}

function isTransientTransportError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /certificate|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out/i.test(error.message)
}

function shouldFallbackOnUpstream(error: UpstreamError): boolean {
    if ((error as any).streamingStarted) return false
    if (error.status === 429) {
        return isQuotaExhausted(error) || (error as any).retryable === true
    }
    return FALLBACK_STATUSES.has(error.status)
}

function isQuotaExhausted(error: UpstreamError): boolean {
    if (error.status !== 429) return false
    const body = (error.body || "").trim()
    if (!body) return false

    if (body.startsWith("{") || body.startsWith("[")) {
        try {
            const json = JSON.parse(body)
            const details = json?.error?.details
            if (Array.isArray(details)) {
                for (const detail of details) {
                    if (detail?.reason === "QUOTA_EXHAUSTED") return true
                }
            }
        } catch {
            // ignore parse errors
        }
    }

    const lower = body.toLowerCase()
    if (lower.includes("quota_exhausted")) return true
    if (lower.includes("quota") && lower.includes("reset")) return true
    return false
}

function getFlowKey(model: string): string {
    const raw = model?.trim() || ""
    if (raw.toLowerCase().startsWith("route:")) {
        return raw.slice("route:".length).trim()
    }
    return raw
}

function selectFlowEntries(config: RoutingConfig, model: string): RoutingEntry[] {
    const { flows } = config
    if (flows.length === 0) {
        return []
    }

    const raw = model?.trim() || ""
    const isRoute = raw.toLowerCase().startsWith("route:")
    const flowKey = getFlowKey(model)
    const exact = flows.find(flow => flow.name === flowKey)
    if (exact) {
        return exact.entries
    }

    if (isRoute) {
        return []
    }

    // 🆕 没有匹配到 flow，返回空数组
    return []
}

function resolveFlowEntries(config: RoutingConfig, model: string): RoutingEntry[] {
    const entries = normalizeEntries(selectFlowEntries(config, model))
    if (entries.length === 0) {
        throw new RoutingError(`No flow routing entries configured for model "${model}"`, 400)
    }
    return entries
}

function resolveFlowSelection(config: RoutingConfig, model: string): { flowKey: string; entries: RoutingEntry[] } {
    const flowKey = getFlowKey(model)
    const entries = normalizeEntries(selectFlowEntries(config, model))
    if (entries.length === 0) {
        throw new RoutingError(`No flow routing entries configured for model "${model}"`, 400)
    }
    return { flowKey, entries }
}

function resolveAccountEntries(config: RoutingConfig, model: string): AccountRoutingEntry[] {
    return resolveAccountRoutingEntries(config, model)
}

function shouldSkipFlowEntry(
    entry: RoutingEntry,
    entriesLength: number,
    options: { ignoreRateLimit?: boolean; ignoreQuotaReserve?: boolean } = {}
): boolean {
    const ignoreRateLimit = options.ignoreRateLimit ?? false
    const ignoreQuotaReserve = options.ignoreQuotaReserve ?? false

    // 🆕 最高优先级：检查账户是否被手动禁用
    if (isAccountDisabled(entry.provider, entry.accountId)) {
        console.log(`[Router] Skipping ${entry.accountId}: account manually disabled`)
        return true
    }

    // 🐛 修复：检查配额是否低于保留阈值
    // 🆕 移除 entriesLength > 1 条件，单账户场景也需要检查配额
    if (!ignoreQuotaReserve) {
        const reservePercent = getSetting("quotaReservePercent") || 0

        // 🆕 层次2：先检查黑名单，避免重复检查 0% 配额账户
        if (isQuotaBlacklisted(entry.provider, entry.accountId, entry.modelId)) {
            console.log(`[Router] Skipping ${entry.accountId}: ${entry.modelId} in quota blacklist`)
            return true
        }

        // 🆕 层次1：使用缓存的配额检查，减少开销
        const quotaPercent = getQuotaCachedPercent(entry.provider, entry.accountId, entry.modelId)
        // 如果配额低于或等于保留阈值，跳过此账户
        // 当 reservePercent = 0 时，只有 quotaPercent = 0% 才会被跳过
        if (quotaPercent !== null && quotaPercent <= reservePercent) {
            console.log(`[Router] Skipping ${entry.accountId}: ${entry.modelId} quota ${quotaPercent}% <= reserve ${reservePercent}%`)
            // 🆕 层次2：0% 配额账户加入黑名单 5 分钟
            if (quotaPercent === 0) {
                addToQuotaBlacklist(entry.provider, entry.accountId, entry.modelId)
            }
            return true
        }
    }

    if (entry.provider === "antigravity") {
        const accountId = entry.accountId === "auto" ? undefined : entry.accountId
        if (!ignoreRateLimit && accountId && entriesLength > 1) {
            const isLimited = accountManager.isAccountRateLimited(accountId) || isRouterRateLimited("antigravity", accountId)
            if (isLimited) return true
            if (accountManager.isAccountInFlight(accountId)) return true
        }
        return false
    }

    if (!ignoreRateLimit && authStore.isRateLimited(entry.provider, entry.accountId)) {
        return true
    }

    const account = authStore.getAccount(entry.provider, entry.accountId)
    return !account
}

function applyFlowRateLimit(entry: RoutingEntry, error: UpstreamError, requestModel: string): void {
    if (entry.provider === "antigravity" && entry.accountId !== "auto") {
        accountManager
            .markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, requestModel, { maxDurationMs: 30_000 })
            .then((limit) => {
                const duration = limit?.durationMs ?? 30_000
                markRouterRateLimited("antigravity", entry.accountId, duration)
            })
            .catch(() => {
                markRouterRateLimited("antigravity", entry.accountId, 30_000)
            })
        return
    }

    if (entry.provider !== "antigravity") {
        authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
        markRouterRateLimited(entry.provider, entry.accountId, 60000)
    }
}

function advanceFlowCursor(flowState: FlowStickyState | null, entries: RoutingEntry[], startIndex: number): void {
    if (!flowState || entries.length <= 1) return
    for (let offset = 1; offset < entries.length; offset++) {
        const nextIndex = (startIndex + offset) % entries.length
        const candidate = entries[nextIndex]
        if (!shouldSkipFlowEntry(candidate, entries.length)) {
            flowState.cursor = nextIndex
            return
        }
    }
}

function recordProviderUsage(modelId: string, completion: ProviderUsage | null | undefined): void {
    if (!completion?.usage) return
    const inputTokens = completion.usage.inputTokens ?? 0
    const outputTokens = completion.usage.outputTokens ?? 0
    if (inputTokens > 0 || outputTokens > 0) {
        recordUsage(modelId, inputTokens, outputTokens)
    }
}

function shouldProbeFlowHead(flowState: FlowStickyState | null, error: UpstreamError): boolean {
    if (!flowState || error.status !== 429) return false
    if (!isQuotaExhausted(error)) return false
    const now = Date.now()
    if (!flowState.lastProbeAt || now - flowState.lastProbeAt >= FLOW_PROBE_INTERVAL_MS) {
        flowState.lastProbeAt = now
        return true
    }
    return false
}

async function createFlowCompletionWithEntries(request: RoutedRequest, entries: RoutingEntry[], flowKey?: string) {
    let lastError: Error | null = null
    let probedHead = false
    const flowState = flowKey ? getFlowStickyState(flowKey, entries.length) : null
    const startIndex = flowState?.cursor ?? 0

    const attemptEntry = async (entry: RoutingEntry) => {
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId })
            return await createChatCompletionWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: accountId ? false : true,
            })
        }

        const account = authStore.getAccount(entry.provider, entry.accountId)
        if (!account) {
            throw new Error("Account not found")
        }
        const accountDisplay = account.login || account.email || entry.accountId
        setRequestLogContext({ model: entry.modelId, provider: entry.provider, account: accountDisplay })

        if (entry.provider === "codex") {
            const startTime = Date.now()
            const result = await createCodexCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
            recordProviderUsage(entry.modelId, result)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Codex >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
            return result
        }

        if (entry.provider === "copilot") {
            const startTime = Date.now()
            const result = await createCopilotCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
            recordProviderUsage(entry.modelId, result)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Copilot >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
            return result
        }

        throw new Error("Unsupported provider")
    }

    for (let index = startIndex; index < entries.length; index++) {
        const entry = entries[index]
        if (shouldSkipFlowEntry(entry, entries.length)) {
            continue
        }
        try {
            const result = await attemptEntry(entry)
            if (flowState) {
                flowState.cursor = index
            }
            return result
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                applyFlowRateLimit(entry, error, request.model)
                if (flowState && index === startIndex) {
                    advanceFlowCursor(flowState, entries, startIndex)
                }

                if (
                    flowState &&
                    index === startIndex &&
                    flowState.cursor === startIndex &&
                    !probedHead &&
                    entries.length > 1 &&
                    (isQuotaExhausted(error) || shouldProbeFlowHead(flowState, error))
                ) {
                    const probeIndex = 0
                    if (probeIndex !== index) {
                        const probeEntry = entries[probeIndex]
                        if (!shouldSkipFlowEntry(probeEntry, entries.length, { ignoreRateLimit: true })) {
                            probedHead = true
                            try {
                                const probeResult = await attemptEntry(probeEntry)
                                flowState.cursor = probeIndex
                                return probeResult
                            } catch (probeError) {
                                lastError = probeError as Error
                                if (probeError instanceof UpstreamError && shouldFallbackOnUpstream(probeError)) {
                                    applyFlowRateLimit(probeEntry, probeError, request.model)
                                } else if (isTransientTransportError(probeError)) {
                                    if (probeEntry.provider !== "antigravity") {
                                        authStore.markRateLimited(probeEntry.provider, probeEntry.accountId, 500, (probeError as Error).message)
                                    }
                                } else {
                                    throw probeError
                                }
                            }
                        }
                    }

                    if (index < entries.length - 1) {
                        flowState.cursor = index + 1
                    }
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        const fallbackIndex = flowState?.cursor ?? 0
        const entry = entries[fallbackIndex]
        try {
            if (entry.provider === "antigravity") {
                const accountId = entry.accountId === "auto" ? undefined : entry.accountId
                setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId })
                return await createChatCompletionWithOptions({ ...request, model: entry.modelId }, {
                    accountId,
                    allowRotation: accountId ? false : true,
                })
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                throw new Error("Account not found")
            }
            const accountDisplay = account.login || account.email || entry.accountId
            setRequestLogContext({ model: entry.modelId, provider: entry.provider, account: accountDisplay })

            if (entry.provider === "codex") {
                const startTime = Date.now()
                const result = await createCodexCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
                recordProviderUsage(entry.modelId, result)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Codex >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
                return result
            }

            if (entry.provider === "copilot") {
                const startTime = Date.now()
                const result = await createCopilotCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
                recordProviderUsage(entry.modelId, result)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Copilot >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
                return result
            }
        } catch (error) {
            lastError = error as Error
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError("No routing entries available", 400)
}

async function createAccountCompletionWithEntries(request: RoutedRequest, entries: AccountRoutingEntry[]) {
    let lastError: Error | null = null
    const accountState = getAccountStickyState(request.model, entries.length)
    const startIndex = accountState?.cursor ?? 0

    // 🐛 修复：添加配额检查（与 shouldSkipFlowEntry 相同逻辑）
    const reservePercent = getSetting("quotaReservePercent") || 0

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${request.model}" cannot use auto without smart switch expansion`, 400)
                }

                // 🆕 最高优先级：检查账户是否被手动禁用
                if (isAccountDisabled(entry.provider, entry.accountId)) {
                    console.log(`[Router] Skipping ${entry.accountId}: account manually disabled`)
                    continue
                }

                const isLimited = accountManager.isAccountRateLimited(entry.accountId) || isRouterRateLimited("antigravity", entry.accountId)
                if (isLimited) continue
                if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) continue

                // 🐛 修复：检查配额（使用请求的模型名，而非 entry.modelId）
                // 🆕 移除 entries.length > 1 条件，单账户场景也需要检查配额

                // 🆕 层次2：先检查黑名单，避免重复检查 0% 配额账户
                if (isQuotaBlacklisted("antigravity", entry.accountId, request.model)) {
                    console.log(`[Router] Skipping ${entry.accountId}: ${request.model} in quota blacklist`)
                    continue
                }

                // 🆕 层次1：使用缓存的配额检查，减少开销
                const quotaPercent = getQuotaCachedPercent("antigravity", entry.accountId, request.model)
                if (quotaPercent !== null && quotaPercent <= reservePercent) {
                    console.log(`[Router] Skipping ${entry.accountId}: ${request.model} quota ${quotaPercent}% <= reserve ${reservePercent}%`)
                    // 🆕 层次2：0% 配额账户加入黑名单 5 分钟
                    if (quotaPercent === 0) {
                        addToQuotaBlacklist("antigravity", entry.accountId, request.model)
                    }
                    continue
                }

                const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
                setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay })
                const result = await createChatCompletionWithOptions({ ...request, model: request.model }, {
                    accountId: entry.accountId,
                    allowRotation: false,
                })
                accountState.cursor = index
                return result
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                continue
            }

            // 🆕 检查非 antigravity 账户是否被手动禁用
            if (isAccountDisabled(entry.provider, entry.accountId)) {
                console.log(`[Router] Skipping ${entry.provider}/${entry.accountId}: account manually disabled`)
                continue
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }

            // 🆕 添加配额检查（与 antigravity 一致）

            // 🆕 层次2：先检查黑名单，避免重复检查 0% 配额账户
            if (isQuotaBlacklisted(entry.provider, entry.accountId, request.model)) {
                console.log(`[Router] Skipping ${entry.provider}/${entry.accountId}: ${request.model} in quota blacklist`)
                continue
            }

            // 🆕 层次1：使用缓存的配额检查，减少开销
            const quotaPercent = getQuotaCachedPercent(entry.provider, entry.accountId, request.model)
            if (quotaPercent !== null && quotaPercent <= reservePercent) {
                console.log(`[Router] Skipping ${entry.provider}/${entry.accountId}: ${request.model} quota ${quotaPercent}% <= reserve ${reservePercent}%`)
                // 🆕 层次2：0% 配额账户加入黑名单 5 分钟
                if (quotaPercent === 0) {
                    addToQuotaBlacklist(entry.provider, entry.accountId, request.model)
                }
                continue
            }

            const accountDisplay = account.login || account.email || entry.accountId
            setRequestLogContext({ model: request.model, provider: entry.provider, account: accountDisplay })

            if (entry.provider === "codex") {
                const startTime = Date.now()
                const result = await createCodexCompletion(account, request.model, request.messages, request.tools, request.maxTokens)
                recordProviderUsage(request.model, result)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Codex >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
                accountState.cursor = index
                return result
            }

            if (entry.provider === "copilot") {
                const startTime = Date.now()
                const result = await createCopilotCompletion(account, request.model, request.messages, request.tools, request.maxTokens)
                recordProviderUsage(request.model, result)
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Copilot >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
                accountState.cursor = index
                return result
            }
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                if (entry.provider === "antigravity") {
                    accountManager.markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, request.model)
                    markRouterRateLimited("antigravity", entry.accountId, 60000)
                } else {
                    authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                    markRouterRateLimited(entry.provider, entry.accountId, 60000)
                }
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError(`No account routing entries available for model "${request.model}"`, 400)
}

// 🆕 检测是否为画图模型
function isImageModel(model: string): boolean {
    return model.toLowerCase().includes("image")
}

// 🆕 从 messages 提取 prompt（用于画图）
function extractPromptFromMessages(messages: ClaudeMessage[]): string {
    // 找最后一个 user 消息作为 prompt
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                return msg.content
            }
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter((block: any) => block.type === "text" && block.text)
                    .map((block: any) => block.text)
                return textParts.join("\n")
            }
        }
    }
    return ""
}

export async function createRoutedCompletion(request: RoutedRequest) {
    if (isHiddenCodexModel(request.model)) {
        throw new RoutingError("Model is not available", 400)
    }

    // 🆕 画图模型特殊处理：调用 image-generation 而非 chat
    if (isImageModel(request.model)) {
        const prompt = extractPromptFromMessages(request.messages)
        if (!prompt) {
            throw new RoutingError("No prompt found in messages for image generation", 400)
        }
        console.log(`[Router] Detected image model ${request.model}, redirecting to image generation`)
        const imageResult = await generateImages({
            model: request.model,
            prompt,
            n: 1,
            response_format: "b64_json"
        })
        // 转换为 chat completion 格式的响应
        const imageData = imageResult.data[0]?.b64_json || ""
        return {
            contentBlocks: [{
                type: "text" as const,
                text: imageData ? `![Generated Image](data:image/png;base64,${imageData})` : "Image generation failed"
            }],
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 }
        }
    }

    const config = loadRoutingConfig()
    const normalizedModel = normalizeModelName(request.model)

    // Debug logging for model normalization
    if (normalizedModel !== request.model) {
        console.log(`[Router] Model normalized: ${request.model} → ${normalizedModel}`)
    }

    if (isOfficialModel(normalizedModel)) {
        const accountEntries = resolveAccountEntries(config, normalizedModel)
        return createAccountCompletionWithEntries({ ...request, model: normalizedModel }, accountEntries)
    }

    const flowSelection = resolveFlowSelection(config, normalizedModel)
    return createFlowCompletionWithEntries({ ...request, model: normalizedModel }, flowSelection.entries, flowSelection.flowKey)
}

async function* createFlowCompletionStreamWithEntries(request: RoutedRequest, entries: RoutingEntry[], flowKey?: string): AsyncGenerator<string, void, unknown> {
    let lastError: Error | null = null
    let probedHead = false
    const flowState = flowKey ? getFlowStickyState(flowKey, entries.length) : null
    const startIndex = flowState?.cursor ?? 0

    async function* streamEntry(entry: RoutingEntry): AsyncGenerator<string, void, unknown> {
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            yield* createChatCompletionStreamWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: accountId ? false : true,
            })
            return
        }

        const account = authStore.getAccount(entry.provider, entry.accountId)
        if (!account) {
            throw new Error("Account not found")
        }
        const accountDisplay = account.login || account.email || entry.accountId

        let completion
        let startTime = 0
        if (entry.provider === "codex") {
            startTime = Date.now()
            completion = await createCodexCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
        } else if (entry.provider === "copilot") {
            startTime = Date.now()
            completion = await createCopilotCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
        }

        if (!completion) {
            throw new Error("Empty completion")
        }

        yield buildMessageStart(request.model)
        let blockIndex = 0
        for (const block of completion.contentBlocks) {
            if (block.type === "tool_use") {
                yield buildContentBlockStart(blockIndex, "tool_use", { id: block.id!, name: block.name! })
                const inputText = JSON.stringify(block.input || {})
                yield buildInputJsonDelta(blockIndex, inputText)
                yield buildContentBlockStop(blockIndex)
                blockIndex++
                continue
            }

            yield buildContentBlockStart(blockIndex, "text")
            yield buildTextDelta(blockIndex, block.text || "")
            yield buildContentBlockStop(blockIndex)
            blockIndex++
        }
        yield buildMessageDelta(completion.stopReason || "end_turn", completion.usage)
        yield buildMessageStop()

        recordProviderUsage(entry.modelId, completion)

        if (entry.provider === "codex") {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Codex >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
        } else if (entry.provider === "copilot") {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Copilot >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
        }
    }

    for (let index = startIndex; index < entries.length; index++) {
        const entry = entries[index]
        if (shouldSkipFlowEntry(entry, entries.length)) {
            continue
        }
        try {
            yield* streamEntry(entry)
            if (flowState) {
                flowState.cursor = index
            }
            return
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                applyFlowRateLimit(entry, error, request.model)
                if (flowState && index === startIndex) {
                    advanceFlowCursor(flowState, entries, startIndex)
                }

                if (
                    flowState &&
                    index === startIndex &&
                    flowState.cursor === startIndex &&
                    !probedHead &&
                    entries.length > 1 &&
                    (isQuotaExhausted(error) || shouldProbeFlowHead(flowState, error))
                ) {
                    const probeIndex = 0
                    if (probeIndex !== index) {
                        const probeEntry = entries[probeIndex]
                        if (!shouldSkipFlowEntry(probeEntry, entries.length, { ignoreRateLimit: true })) {
                            probedHead = true
                            try {
                                yield* streamEntry(probeEntry)
                                flowState.cursor = probeIndex
                                return
                            } catch (probeError) {
                                lastError = probeError as Error
                                if (probeError instanceof UpstreamError && shouldFallbackOnUpstream(probeError)) {
                                    applyFlowRateLimit(probeEntry, probeError, request.model)
                                } else if (isTransientTransportError(probeError)) {
                                    if (probeEntry.provider !== "antigravity") {
                                        authStore.markRateLimited(probeEntry.provider, probeEntry.accountId, 500, (probeError as Error).message)
                                    }
                                } else {
                                    throw probeError
                                }
                            }
                        }
                    }

                    if (index < entries.length - 1) {
                        flowState.cursor = index + 1
                    }
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        const fallbackIndex = flowState?.cursor ?? 0
        const entry = entries[fallbackIndex]
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            yield* createChatCompletionStreamWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: accountId ? false : true,
            })
            return
        }

        const account = authStore.getAccount(entry.provider, entry.accountId)
        if (!account) {
            throw new Error("Account not found")
        }
        const accountDisplay = account.login || account.email || entry.accountId

        let completion
        let startTime = 0
        if (entry.provider === "codex") {
            startTime = Date.now()
            completion = await createCodexCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
        } else if (entry.provider === "copilot") {
            startTime = Date.now()
            completion = await createCopilotCompletion(account, entry.modelId, request.messages, request.tools, request.maxTokens)
        }

        if (!completion) {
            throw new Error("Empty completion")
        }

        yield buildMessageStart(request.model)
        let blockIndex = 0
        for (const block of completion.contentBlocks) {
            if (block.type === "tool_use") {
                yield buildContentBlockStart(blockIndex, "tool_use", { id: block.id!, name: block.name! })
                const inputText = JSON.stringify(block.input || {})
                yield buildInputJsonDelta(blockIndex, inputText)
                yield buildContentBlockStop(blockIndex)
                blockIndex++
                continue
            }

            yield buildContentBlockStart(blockIndex, "text")
            yield buildTextDelta(blockIndex, block.text || "")
            yield buildContentBlockStop(blockIndex)
            blockIndex++
        }
        yield buildMessageDelta(completion.stopReason || "end_turn", completion.usage)
        yield buildMessageStop()

        recordProviderUsage(entry.modelId, completion)

        if (entry.provider === "codex") {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Codex >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
        } else if (entry.provider === "copilot") {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Copilot >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
        }
        return
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError("No routing entries available", 400)
}

async function* createAccountCompletionStreamWithEntries(request: RoutedRequest, entries: AccountRoutingEntry[]): AsyncGenerator<string, void, unknown> {
    let lastError: Error | null = null
    const accountState = getAccountStickyState(request.model, entries.length)
    const startIndex = accountState?.cursor ?? 0

    // 🐛 修复：添加配额检查（与 shouldSkipFlowEntry 相同逻辑）
    const reservePercent = getSetting("quotaReservePercent") || 0

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${request.model}" cannot use auto without smart switch expansion`, 400)
                }

                // 🆕 最高优先级：检查账户是否被手动禁用
                if (isAccountDisabled(entry.provider, entry.accountId)) {
                    console.log(`[Router] Skipping ${entry.accountId}: account manually disabled`)
                    continue
                }

                const isLimited = accountManager.isAccountRateLimited(entry.accountId) || isRouterRateLimited("antigravity", entry.accountId)
                if (isLimited) continue
                if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) continue

                // 🐛 修复：检查配额（使用请求的模型名，而非 entry.modelId）
                // 🆕 移除 entries.length > 1 条件，单账户场景也需要检查配额
                const quotaPercent = getAccountModelQuotaPercent("antigravity", entry.accountId, request.model)
                if (quotaPercent !== null && quotaPercent <= reservePercent) {
                    console.log(`[Router] Skipping ${entry.accountId}: ${request.model} quota ${quotaPercent}% <= reserve ${reservePercent}%`)
                    continue
                }

                yield* createChatCompletionStreamWithOptions({ ...request, model: request.model }, {
                    accountId: entry.accountId,
                    allowRotation: false,
                })
                accountState.cursor = index
                return
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                continue
            }

            // 🆕 检查非 antigravity 账户是否被手动禁用
            if (isAccountDisabled(entry.provider, entry.accountId)) {
                console.log(`[Router] Skipping ${entry.provider}/${entry.accountId}: account manually disabled`)
                continue
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }

            // 🆕 添加配额检查（与 antigravity 一致）
            const quotaPercent = getAccountModelQuotaPercent(entry.provider, entry.accountId, request.model)
            if (quotaPercent !== null && quotaPercent <= reservePercent) {
                console.log(`[Router] Skipping ${entry.provider}/${entry.accountId}: ${request.model} quota ${quotaPercent}% <= reserve ${reservePercent}%`)
                continue
            }

            const accountDisplay = account.login || account.email || entry.accountId

            let completion
            let startTime = 0
            if (entry.provider === "codex") {
                startTime = Date.now()
                completion = await createCodexCompletion(account, request.model, request.messages, request.tools, request.maxTokens)
            } else if (entry.provider === "copilot") {
                startTime = Date.now()
                completion = await createCopilotCompletion(account, request.model, request.messages, request.tools, request.maxTokens)
            }

            if (!completion) {
                throw new Error("Empty completion")
            }

            yield buildMessageStart(request.model)
            let blockIndex = 0
            for (const block of completion.contentBlocks) {
                if (block.type === "tool_use") {
                    yield buildContentBlockStart(blockIndex, "tool_use", { id: block.id!, name: block.name! })
                    const inputText = JSON.stringify(block.input || {})
                    yield buildInputJsonDelta(blockIndex, inputText)
                    yield buildContentBlockStop(blockIndex)
                    blockIndex++
                    continue
                }

                yield buildContentBlockStart(blockIndex, "text")
                yield buildTextDelta(blockIndex, block.text || "")
                yield buildContentBlockStop(blockIndex)
                blockIndex++
            }
            yield buildMessageDelta(completion.stopReason || "end_turn", completion.usage)
            yield buildMessageStop()

            recordProviderUsage(request.model, completion)

            if (entry.provider === "codex") {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Codex >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
            } else if (entry.provider === "copilot") {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                console.log(`\x1b[32m[${formatLogTime()}] 200: from ${request.model} > Copilot >> ${accountDisplay} (${elapsed}s)\x1b[0m`)
            }
            accountState.cursor = index
            return
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
                if (entry.provider === "antigravity") {
                    accountManager.markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, request.model)
                    markRouterRateLimited("antigravity", entry.accountId, 60000)
                } else {
                    authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                    markRouterRateLimited(entry.provider, entry.accountId, 60000)
                }
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError(`No account routing entries available for model "${request.model}"`, 400)
}

export async function* createRoutedCompletionStream(request: RoutedRequest): AsyncGenerator<string, void, unknown> {
    if (isHiddenCodexModel(request.model)) {
        throw new RoutingError("Model is not available", 400)
    }

    // 🆕 画图模型特殊处理：调用 image-generation 而非 chat
    if (isImageModel(request.model)) {
        const prompt = extractPromptFromMessages(request.messages)
        if (!prompt) {
            throw new RoutingError("No prompt found in messages for image generation", 400)
        }
        console.log(`[Router] Detected image model ${request.model}, redirecting to image generation (stream)`)
        const imageResult = await generateImages({
            model: request.model,
            prompt,
            n: 1,
            response_format: "b64_json"
        })
        // 转换为流式 chat completion 格式
        const imageData = imageResult.data[0]?.b64_json || ""
        const imageText = imageData ? `![Generated Image](data:image/png;base64,${imageData})` : "Image generation failed"

        yield buildMessageStart(request.model)
        yield buildContentBlockStart(0, "text")
        yield buildTextDelta(0, imageText)
        yield buildContentBlockStop(0)
        yield buildMessageDelta("end_turn", { inputTokens: 0, outputTokens: 0 })
        yield buildMessageStop()
        return
    }

    const config = loadRoutingConfig()
    const normalizedModel = normalizeModelName(request.model)

    // Debug logging for model normalization
    if (normalizedModel !== request.model) {
        console.log(`[Router] Model normalized: ${request.model} → ${normalizedModel}`)
    }

    if (isOfficialModel(normalizedModel)) {
        const accountEntries = resolveAccountEntries(config, normalizedModel)
        yield* createAccountCompletionStreamWithEntries({ ...request, model: normalizedModel }, accountEntries)
        return
    }

    const flowSelection = resolveFlowSelection(config, normalizedModel)
    yield* createFlowCompletionStreamWithEntries({ ...request, model: normalizedModel }, flowSelection.entries, flowSelection.flowKey)
}
