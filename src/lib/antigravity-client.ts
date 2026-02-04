const DEFAULT_ANTIGRAVITY_IDE_VERSION = "1.15.8"

export function getAntigravityIdeVersion(): string {
    return process.env.ANTIGRAVITY_IDE_VERSION?.trim() || DEFAULT_ANTIGRAVITY_IDE_VERSION
}

export function getAntigravityUserAgent(): string {
    const envAgent = process.env.ANTIGRAVITY_USER_AGENT?.trim()
    if (envAgent) return envAgent
    const version = getAntigravityIdeVersion()
    const platform = process.platform === "darwin" ? "macos" : process.platform
    const arch = process.arch
    return `antigravity/${version} ${platform}/${arch}`
}
