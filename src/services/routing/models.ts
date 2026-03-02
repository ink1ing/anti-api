import { AVAILABLE_MODELS } from "~/lib/config"
import type { AuthProvider } from "~/services/auth/types"

export interface ProviderModelOption {
    id: string
    label: string
}

const CODEX_HIDDEN_MODELS = new Set([
    "gpt-5.3-max-high",
    "gpt-5.3-max",
    "gpt-5.2-max-high",
    "gpt-5.2-max",
])

const CODEX_MODELS: ProviderModelOption[] = [
    { id: "gpt-5.3-max-high", label: "Codex - 5.3 Max (High)" },
    { id: "gpt-5.3-max", label: "Codex - 5.3 Max" },
    { id: "gpt-5.3", label: "Codex - 5.3" },
    { id: "gpt-5.3-codex", label: "Codex - 5.3 Codex" },
    { id: "gpt-5.2-max-high", label: "Codex - 5.2 Max (High)" },
    { id: "gpt-5.2-max", label: "Codex - 5.2 Max" },
    { id: "gpt-5.2", label: "Codex - 5.2" },
    { id: "gpt-5.2-codex", label: "Codex - 5.2 Codex" },
    { id: "gpt-5.1", label: "Codex - 5.1" },
    { id: "gpt-5.1-codex", label: "Codex - 5.1 Codex" },
    { id: "gpt-5.1-codex-max", label: "Codex - 5.1 Codex Max" },
    { id: "gpt-5.1-codex-mini", label: "Codex - 5.1 Codex Mini" },
    { id: "gpt-5", label: "Codex - 5" },
    { id: "gpt-5-codex", label: "Codex - 5 Codex" },
    { id: "gpt-5-codex-mini", label: "Codex - 5 Codex Mini" },
]

const COPILOT_STATIC_MODELS: ProviderModelOption[] = [
    { id: "claude-opus-4-5-thinking", label: "Copilot - Opus 4.5 Thinking" },
    { id: "claude-sonnet-4-5", label: "Copilot - Sonnet 4.5" },
    { id: "claude-sonnet-4-5-thinking", label: "Copilot - Sonnet 4.5 Thinking" },
    { id: "gpt-4o", label: "Copilot - GPT-4o" },
    { id: "gpt-4o-mini", label: "Copilot - GPT-4o Mini" },
    { id: "gpt-4.1", label: "Copilot - GPT-4.1" },
    { id: "gpt-4.1-mini", label: "Copilot - GPT-4.1 Mini" },
]

let dynamicCopilotModels: ProviderModelOption[] = []
let dynamicCodexModels: ProviderModelOption[] = []
let dynamicAntigravityModels: ProviderModelOption[] = []
const dynamicCopilotModelsByAccount = new Map<string, ProviderModelOption[]>()
const dynamicCodexModelsByAccount = new Map<string, ProviderModelOption[]>()
const dynamicAntigravityModelsByAccount = new Map<string, ProviderModelOption[]>()

function sanitizeModelOptions(models: ProviderModelOption[], prefix: string): ProviderModelOption[] {
    const deduped = new Map<string, ProviderModelOption>()

    for (const model of models) {
        const id = model?.id?.trim()
        if (!id) continue
        if (deduped.has(id)) continue

        const label = model?.label?.trim() || `${prefix} - ${id}`
        deduped.set(id, { id, label })
    }

    return Array.from(deduped.values())
}

function mergeModelOptions(...groups: ProviderModelOption[][]): ProviderModelOption[] {
    const merged = new Map<string, ProviderModelOption>()
    for (const group of groups) {
        for (const model of group) {
            if (!merged.has(model.id)) {
                merged.set(model.id, model)
            }
        }
    }
    return Array.from(merged.values())
}

function flattenDynamicModelsByAccount(bucket: Map<string, ProviderModelOption[]>): ProviderModelOption[] {
    return Array.from(bucket.values()).flat()
}

export function setDynamicCopilotModels(models: ProviderModelOption[]): void {
    dynamicCopilotModels = sanitizeModelOptions(models, "Copilot")
}

export function clearDynamicCopilotModels(): void {
    dynamicCopilotModels = []
    dynamicCopilotModelsByAccount.clear()
}

export function setDynamicCopilotModelsForAccount(accountId: string, models: ProviderModelOption[]): void {
    const id = accountId?.trim()
    if (!id) return
    dynamicCopilotModelsByAccount.set(id, sanitizeModelOptions(models, "Copilot"))
}

export function clearDynamicCopilotModelsForAccount(accountId: string): void {
    dynamicCopilotModelsByAccount.delete(accountId)
}

export function clearAllDynamicCopilotModelsByAccount(): void {
    dynamicCopilotModelsByAccount.clear()
}

export function setDynamicCodexModels(models: ProviderModelOption[]): void {
    dynamicCodexModels = sanitizeModelOptions(models, "Codex")
        .filter(model => !CODEX_HIDDEN_MODELS.has(model.id))
}

export function clearDynamicCodexModels(): void {
    dynamicCodexModels = []
    dynamicCodexModelsByAccount.clear()
}

export function setDynamicCodexModelsForAccount(accountId: string, models: ProviderModelOption[]): void {
    const id = accountId?.trim()
    if (!id) return
    const sanitized = sanitizeModelOptions(models, "Codex")
        .filter(model => !CODEX_HIDDEN_MODELS.has(model.id))
    dynamicCodexModelsByAccount.set(id, sanitized)
}

export function clearDynamicCodexModelsForAccount(accountId: string): void {
    dynamicCodexModelsByAccount.delete(accountId)
}

export function clearAllDynamicCodexModelsByAccount(): void {
    dynamicCodexModelsByAccount.clear()
}

export function setDynamicAntigravityModels(models: ProviderModelOption[]): void {
    dynamicAntigravityModels = sanitizeModelOptions(models, "Antigravity")
}

export function clearDynamicAntigravityModels(): void {
    dynamicAntigravityModels = []
    dynamicAntigravityModelsByAccount.clear()
}

export function setDynamicAntigravityModelsForAccount(accountId: string, models: ProviderModelOption[]): void {
    const id = accountId?.trim()
    if (!id) return
    dynamicAntigravityModelsByAccount.set(id, sanitizeModelOptions(models, "Antigravity"))
}

export function clearDynamicAntigravityModelsForAccount(accountId: string): void {
    dynamicAntigravityModelsByAccount.delete(accountId)
}

export function clearAllDynamicAntigravityModelsByAccount(): void {
    dynamicAntigravityModelsByAccount.clear()
}

export function getProviderModels(provider: AuthProvider): ProviderModelOption[] {
    if (provider === "antigravity") {
        const staticModels = AVAILABLE_MODELS.map(model => ({
            id: model.id,
            label: model.name,
        }))
        return mergeModelOptions(
            flattenDynamicModelsByAccount(dynamicAntigravityModelsByAccount),
            dynamicAntigravityModels,
            staticModels
        )
    }

    if (provider === "copilot") {
        return mergeModelOptions(
            flattenDynamicModelsByAccount(dynamicCopilotModelsByAccount),
            dynamicCopilotModels,
            COPILOT_STATIC_MODELS
        )
    }

    if (provider === "codex") {
        const mergedDynamic = mergeModelOptions(
            flattenDynamicModelsByAccount(dynamicCodexModelsByAccount),
            dynamicCodexModels
        )
        if (mergedDynamic.length > 0) {
            return mergedDynamic
        }
        return CODEX_MODELS.filter(model => !CODEX_HIDDEN_MODELS.has(model.id))
    }

    return []
}

export function getProviderModelsForAccount(provider: AuthProvider, accountId: string): ProviderModelOption[] {
    if (provider === "copilot") {
        const dynamic = dynamicCopilotModelsByAccount.get(accountId)
        if (dynamic && dynamic.length > 0) {
            return mergeModelOptions(dynamic, COPILOT_STATIC_MODELS)
        }
        return getProviderModels(provider)
    }
    if (provider === "codex") {
        const dynamic = dynamicCodexModelsByAccount.get(accountId)
        if (dynamic && dynamic.length > 0) {
            const staticModels = CODEX_MODELS.filter(model => !CODEX_HIDDEN_MODELS.has(model.id))
            return mergeModelOptions(dynamic, staticModels)
        }
        return getProviderModels(provider)
    }
    if (provider === "antigravity") {
        const dynamic = dynamicAntigravityModelsByAccount.get(accountId)
        if (dynamic && dynamic.length > 0) {
            const staticModels = AVAILABLE_MODELS.map(model => ({ id: model.id, label: model.name }))
            return mergeModelOptions(dynamic, staticModels)
        }
        return getProviderModels(provider)
    }
    return []
}

export function isHiddenCodexModel(modelId: string): boolean {
    return CODEX_HIDDEN_MODELS.has(modelId)
}
