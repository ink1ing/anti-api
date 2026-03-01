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

export function setDynamicCopilotModels(models: ProviderModelOption[]): void {
    dynamicCopilotModels = sanitizeModelOptions(models, "Copilot")
}

export function clearDynamicCopilotModels(): void {
    dynamicCopilotModels = []
}

export function setDynamicCodexModels(models: ProviderModelOption[]): void {
    dynamicCodexModels = sanitizeModelOptions(models, "Codex")
        .filter(model => !CODEX_HIDDEN_MODELS.has(model.id))
}

export function clearDynamicCodexModels(): void {
    dynamicCodexModels = []
}

export function getProviderModels(provider: AuthProvider): ProviderModelOption[] {
    if (provider === "antigravity") {
        return AVAILABLE_MODELS.map(model => ({
            id: model.id,
            label: model.name,
        }))
    }

    if (provider === "copilot") {
        return mergeModelOptions(dynamicCopilotModels, COPILOT_STATIC_MODELS)
    }

    if (provider === "codex") {
        if (dynamicCodexModels.length > 0) {
            return dynamicCodexModels
        }
        return CODEX_MODELS.filter(model => !CODEX_HIDDEN_MODELS.has(model.id))
    }

    return []
}

export function isHiddenCodexModel(modelId: string): boolean {
    return CODEX_HIDDEN_MODELS.has(modelId)
}
