/**
 * Antigravity Version Fetcher
 * 
 * 自动从 VS Code Marketplace 获取 Gemini Code Assist 扩展的最新版本号
 */

import { platform, arch } from "node:os"

// VS Code Marketplace API
const MARKETPLACE_API = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"
const EXTENSION_ID = "Google.geminicodeassist"

// 缓存版本号，避免频繁请求
let cachedVersion: string | null = null
let cacheTime: number = 0
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 小时缓存

// 硬编码的 fallback 版本（当无法获取时使用）
const FALLBACK_VERSION = "1.15.8"

/**
 * 从 VS Code Marketplace 获取 Gemini Code Assist 扩展版本
 */
export async function fetchLatestAntigravityVersion(): Promise<string> {
    // 检查缓存
    if (cachedVersion && Date.now() - cacheTime < CACHE_TTL_MS) {
        return cachedVersion
    }

    try {
        const response = await fetch(MARKETPLACE_API, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json;api-version=7.1-preview.1",
            },
            body: JSON.stringify({
                filters: [{
                    criteria: [
                        { filterType: 7, value: EXTENSION_ID }  // 7 = ExtensionId
                    ]
                }],
                flags: 0x200  // IncludeVersions
            }),
        })

        if (!response.ok) {
            throw new Error(`Marketplace API returned ${response.status}`)
        }

        const data = await response.json() as any
        const extension = data?.results?.[0]?.extensions?.[0]
        const version = extension?.versions?.[0]?.version

        if (version) {
            cachedVersion = version
            cacheTime = Date.now()
            console.debug(`[VersionFetcher] Got version from Marketplace: ${version}`)
            return version
        }

        throw new Error("Version not found in response")
    } catch (error) {
        console.warn(`[VersionFetcher] Failed to fetch version: ${error}. Using fallback: ${FALLBACK_VERSION}`)
        return FALLBACK_VERSION
    }
}

/**
 * 获取 Antigravity User-Agent 字符串
 * 格式: antigravity/{version} {os}/{arch}
 */
export async function getAntigravityUserAgentAsync(): Promise<string> {
    const version = await fetchLatestAntigravityVersion()
    const os = platform()
    const architecture = arch()
    return `antigravity/${version} ${os}/${architecture}`
}

/**
 * 同步获取版本号（使用缓存或 fallback）
 * 用于不能 await 的场景
 */
export function getAntigravityVersionSync(): string {
    return cachedVersion || FALLBACK_VERSION
}

/**
 * 同步获取 User-Agent（使用缓存或 fallback）
 */
export function getAntigravityUserAgentSync(): string {
    const version = getAntigravityVersionSync()
    const os = platform()
    const architecture = arch()
    return `antigravity/${version} ${os}/${architecture}`
}

/**
 * 预热版本缓存（在启动时调用）
 */
export async function warmupVersionCache(): Promise<void> {
    try {
        const version = await fetchLatestAntigravityVersion()
        console.log(`[VersionFetcher] Antigravity version: ${version}`)
    } catch (error) {
        console.warn(`[VersionFetcher] Failed to warmup version cache: ${error}`)
    }
}
