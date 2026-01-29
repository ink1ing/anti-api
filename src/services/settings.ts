/**
 * Server-side Settings Service
 * Stores user preferences in a JSON file
 */

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs"
import { join } from "path"
import { ensureDataDir, getDataDir } from "~/lib/data-dir"

const SETTINGS_DIR = getDataDir()
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json")

export interface AppSettings {
    preloadRouting: boolean
    autoNgrok: boolean
    autoOpenDashboard: boolean
    autoRefresh: boolean
    autoRestart: boolean
    privacyMode: boolean
    compactLayout: boolean
    trackUsage: boolean
    optimizeQuotaSort: boolean
    captureLogs: boolean
    // 配额保留设置：当账户配额低于此百分比时切换到下一个账户
    quotaReservePercent: number
    // API Key 安全：保护 API 端点
    apiKey: string
    apiKeyEnabled: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
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
    quotaReservePercent: 0, // 默认不保留，0 表示用尽才切换
    apiKey: "", // 首次加载时自动生成
    apiKeyEnabled: false, // 默认关闭，用户可手动开启
}

function generateApiKey(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    let key = "anti-"
    for (let i = 0; i < 24; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return key
}

function ensureSettingsDir(): void {
    ensureDataDir()
}

export function loadSettings(): AppSettings {
    ensureSettingsDir()
    let settings = { ...DEFAULT_SETTINGS }
    try {
        if (existsSync(SETTINGS_FILE)) {
            const data = readFileSync(SETTINGS_FILE, "utf-8")
            settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) }
        }
    } catch (error) {
        // Ignore errors, use defaults
    }
    // 自动生成 API Key（如果为空）
    if (!settings.apiKey) {
        settings.apiKey = generateApiKey()
        writeSettingsFile(settings)
    }
    return settings
}

export function regenerateApiKey(): string {
    const current = loadSettings()
    const newKey = generateApiKey()
    current.apiKey = newKey
    writeSettingsFile(current)
    return newKey
}

function writeSettingsFile(settings: AppSettings): void {
    ensureSettingsDir()
    const payload = JSON.stringify(settings, null, 2)
    const tmpFile = `${SETTINGS_FILE}.tmp`
    writeFileSync(tmpFile, payload, "utf-8")
    try {
        renameSync(tmpFile, SETTINGS_FILE)
    } catch {
        try {
            rmSync(SETTINGS_FILE, { force: true })
        } catch {
            // Ignore cleanup failures
        }
        renameSync(tmpFile, SETTINGS_FILE)
    }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
    const current = loadSettings()
    const updated = { ...current, ...settings }
    writeSettingsFile(updated)
    return updated
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return loadSettings()[key]
}
