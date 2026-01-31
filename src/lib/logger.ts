/**
 * Clean console logging utility for Anti-API
 * Provides formatted output for server status and request logs
 */

const SEPARATOR = "================================"

// Provider display names
const PROVIDER_NAMES: Record<string, string> = {
    copilot: "GitHub Copilot",
    codex: "ChatGPT Codex",
    antigravity: "Antigravity",
}

const PROVIDER_LABELS: Record<string, string> = {
    copilot: "Copilot",
    codex: "Codex",
    antigravity: "Antigravity",
}

// Request context for logging (set by router, read by middleware)
export interface RequestLogContext {
    model?: string
    provider?: string
    account?: string
    routeTag?: string
}

let lastRequestContext: RequestLogContext = {}

export function formatLogTime(): string {
    return new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
    })
}

export function setRequestLogContext(ctx: RequestLogContext): void {
    lastRequestContext = ctx
}

export function getRequestLogContext(): RequestLogContext {
    const ctx = lastRequestContext
    lastRequestContext = {} // Clear after read
    return ctx
}

/**
 * Print startup banner
 */
export function logStartup(port: number): void {
    console.log("")
    console.log(SEPARATOR)
    console.log("")
    console.log("Starting…")
}

/**
 * Print startup success
 */
export function logStartupSuccess(port: number): void {
    console.log(`Succeed. PID: ${process.pid}.`)
    console.log(`listen on: http://localhost:${port}/quota`)
    console.log("")
    console.log(SEPARATOR)
    console.log("")
}

/**
 * Log a successful request with model/provider/account info
 */
export function logRequest(status: number, model?: string, provider?: string, account?: string): void {
    if (status >= 200 && status < 300) {
        if (model && provider) {
            const providerName = PROVIDER_NAMES[provider] || provider
            const accountPart = account ? ` >> ${account}` : ""
            console.log(`${status}: from ${model} > ${providerName}${accountPart}`)
        } else {
            console.log(`${status}: ok`)
        }
    } else {
        console.log(`${status}: error`)
    }
}

export function formatSuccessLine(params: {
    elapsed: string
    model?: string
    provider?: string
    account?: string
    routeTag?: string
}): string {
    const model = params.model || "unknown"
    const provider = params.provider || "unknown"
    const providerLabel = PROVIDER_LABELS[provider] || provider
    const account = params.account || "-"
    const line = `[${formatLogTime()}] 200 ${model}•${providerLabel}•${account}•${params.elapsed}s`
    return `\x1b[32m${line}\x1b[0m`
}

/**
 * Log quota request
 */
export function logQuota(): void {
    console.log("200: get quota")
}

/**
 * Log error with short message
 */
export function logError(status: number, message?: string): void {
    console.log(`${status}: ${message || "error"}`)
}
