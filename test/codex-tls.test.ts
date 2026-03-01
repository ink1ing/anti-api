import { expect, test } from "bun:test"

const ENV_KEY = "ANTI_API_CODEX_INSECURE_TLS"

async function importCodexModule() {
    return await import(`../src/services/codex/chat.ts?${Date.now()}-${Math.random()}`)
}

test("codex TLS defaults to secure mode", async () => {
    const prev = process.env[ENV_KEY]
    delete process.env[ENV_KEY]

    const mod = await importCodexModule()
    expect(mod.isCodexInsecureTlsEnabled()).toBe(false)

    if (prev !== undefined) {
        process.env[ENV_KEY] = prev
    }
})

test("codex TLS insecure mode is enabled by env var", async () => {
    const prev = process.env[ENV_KEY]
    process.env[ENV_KEY] = "1"

    const mod = await importCodexModule()
    expect(mod.isCodexInsecureTlsEnabled()).toBe(true)

    if (prev === undefined) {
        delete process.env[ENV_KEY]
    } else {
        process.env[ENV_KEY] = prev
    }
})
