import { afterAll, test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const tempHome = mkdtempSync(join(tmpdir(), "anti-api-cred-disabled-"))
const tempDataDir = join(tempHome, ".anti-api")
mkdirSync(tempDataDir, { recursive: true })

const prevHome = process.env.HOME
const prevProfile = process.env.USERPROFILE
const prevDataDir = process.env.ANTI_API_DATA_DIR
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.ANTI_API_DATA_DIR = tempDataDir

const serverPromise = import(`../src/server.ts?${Date.now()}-${Math.random()}`).then(mod => mod.server)
const REMOVED_MESSAGE = "Credential bundle export/import has been removed."

afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
    if (prevDataDir === undefined) delete process.env.ANTI_API_DATA_DIR
    else process.env.ANTI_API_DATA_DIR = prevDataDir
})

test("bundle export endpoint is disabled", async () => {
    const server = await serverPromise
    const res = await server.request("/bundle/export")
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ success: false, error: REMOVED_MESSAGE })
})

test("bundle import endpoint is disabled", async () => {
    const server = await serverPromise
    const res = await server.request("/bundle/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
    })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ success: false, error: REMOVED_MESSAGE })
})

test("auth export endpoint is disabled", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/export")
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ success: false, error: REMOVED_MESSAGE })
})

test("auth import endpoint is disabled", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accounts: [] }),
    })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ success: false, error: REMOVED_MESSAGE })
})

test("auth status endpoint is still available", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/status")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.authenticated).toBe("boolean")
})
