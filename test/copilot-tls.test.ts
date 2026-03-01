import { expect, test } from "bun:test"

const ENV_KEY = "ANTI_API_COPILOT_INSECURE_TLS"

async function importCopilotModule() {
    return await import(`../src/services/copilot/chat.ts?${Date.now()}-${Math.random()}`)
}

test("copilot TLS defaults to secure mode", async () => {
    const prev = process.env[ENV_KEY]
    delete process.env[ENV_KEY]

    const mod = await importCopilotModule()
    expect(mod.isCopilotInsecureTlsEnabled()).toBe(false)

    if (prev !== undefined) {
        process.env[ENV_KEY] = prev
    }
})

test("copilot TLS insecure mode is enabled by env var", async () => {
    const prev = process.env[ENV_KEY]
    process.env[ENV_KEY] = "1"

    const mod = await importCopilotModule()
    expect(mod.isCopilotInsecureTlsEnabled()).toBe(true)

    if (prev === undefined) {
        delete process.env[ENV_KEY]
    } else {
        process.env[ENV_KEY] = prev
    }
})
