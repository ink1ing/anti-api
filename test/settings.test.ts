import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

function withTempHome(): { dir: string; prevHome: string | undefined; prevProfile: string | undefined } {
    const dir = mkdtempSync(join(tmpdir(), "anti-api-settings-"))
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    return { dir, prevHome, prevProfile }
}

function restoreEnv(prevHome: string | undefined, prevProfile: string | undefined) {
    if (prevHome === undefined) {
        delete process.env.HOME
    } else {
        process.env.HOME = prevHome
    }
    if (prevProfile === undefined) {
        delete process.env.USERPROFILE
    } else {
        process.env.USERPROFILE = prevProfile
    }
}

test("loadSettings returns defaults in a fresh home", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { loadSettings } = await import(`../src/services/settings.ts?${Date.now()}`)
    const settings = loadSettings()

    expect(settings).toEqual({
        preloadRouting: true,
        autoNgrok: false,
        autoOpenDashboard: true,
        autoRefresh: true,
        autoRestart: false,
        privacyMode: false,
        compactLayout: false,
        trackUsage: true,
        optimizeQuotaSort: false,
        captureLogs: false,
    })

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})

test("saveSettings merges updates with defaults", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { loadSettings, saveSettings } = await import(`../src/services/settings.ts?${Date.now()}`)

    saveSettings({ autoNgrok: true, privacyMode: true })
    const settings = loadSettings()

    expect(settings.autoNgrok).toBe(true)
    expect(settings.privacyMode).toBe(true)
    expect(settings.preloadRouting).toBe(true)
    expect(settings.autoOpenDashboard).toBe(true)
    expect(settings.trackUsage).toBe(true)

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})
