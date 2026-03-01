import { afterEach, expect, test } from "bun:test"
import { clearDynamicCodexModels, clearDynamicCopilotModels, getProviderModels, setDynamicCodexModels, setDynamicCopilotModels } from "~/services/routing/models"

afterEach(() => {
    clearDynamicCopilotModels()
    clearDynamicCodexModels()
})

test("copilot models fall back to static list when dynamic list is empty", () => {
    clearDynamicCopilotModels()
    const models = getProviderModels("copilot")

    expect(models.some(model => model.id === "gpt-4o")).toBe(true)
    expect(models.some(model => model.id === "claude-opus-4-5-thinking")).toBe(true)
})

test("copilot models merge dynamic models before static fallback", () => {
    setDynamicCopilotModels([
        { id: "gpt-5.2", label: "Copilot - GPT-5.2" },
        { id: "gpt-4o", label: "Copilot - GPT-4o Dynamic" },
    ])

    const models = getProviderModels("copilot")
    const gpt52 = models.find(model => model.id === "gpt-5.2")
    const gpt4o = models.find(model => model.id === "gpt-4o")

    expect(gpt52?.label).toBe("Copilot - GPT-5.2")
    expect(gpt4o?.label).toBe("Copilot - GPT-4o Dynamic")
})

test("dynamic copilot model options are sanitized and deduplicated", () => {
    setDynamicCopilotModels([
        { id: " gpt-5.2 ", label: "  Copilot - GPT-5.2  " },
        { id: "gpt-5.2", label: "Copilot - Duplicate" },
        { id: "", label: "invalid" },
    ])

    const models = getProviderModels("copilot")
    const matches = models.filter(model => model.id === "gpt-5.2")

    expect(matches.length).toBe(1)
    expect(matches[0].label).toBe("Copilot - GPT-5.2")
})

test("codex models fall back to static list when dynamic list is empty", () => {
    clearDynamicCodexModels()
    const models = getProviderModels("codex")

    expect(models.some(model => model.id === "gpt-5.3-codex")).toBe(true)
})

test("codex dynamic models override static list when available", () => {
    setDynamicCodexModels([
        { id: "gpt-5.3-codex", label: "Codex - 5.3 Codex" },
        { id: "gpt-5.2-codex", label: "Codex - 5.2 Codex" },
    ])

    const models = getProviderModels("codex")
    expect(models.map(model => model.id)).toEqual(["gpt-5.3-codex", "gpt-5.2-codex"])
})
