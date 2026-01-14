/**
 * Rust Proxy Bridge
 * Connects to Rust proxy binary started by start.command
 * Does NOT spawn new processes - avoids port conflicts
 */

import consola from "consola"

const RUST_PROXY_PORT = 8965

let proxyChecked = false
let proxyAvailable = false

/**
 * Check if Rust proxy is running (started by start.command)
 */
export async function startRustProxy(): Promise<void> {
    if (proxyChecked && proxyAvailable) return

    // Just check if proxy is running, don't spawn new process
    try {
        const response = await fetch(`http://127.0.0.1:${RUST_PROXY_PORT}/health`, {
            method: "GET",
            signal: AbortSignal.timeout(2000),
        })
        if (response.ok) {
            if (!proxyChecked) {
                consola.success("🦀 Connected to Rust proxy on port", RUST_PROXY_PORT)
            }
            proxyChecked = true
            proxyAvailable = true
        }
    } catch (e) {
        proxyChecked = true
        proxyAvailable = false
        throw new Error("Rust proxy not running - please start via start.command")
    }
}

/**
 * Check if Rust proxy is ready
 */
export function isRustProxyReady(): boolean {
    return proxyAvailable
}

/**
 * Send a request through the Rust proxy
 */
export async function sendViaRustProxy(
    model: string,
    project: string,
    accessToken: string,
    request: any
): Promise<{ success: boolean; data?: string; error?: string }> {
    if (!proxyAvailable) {
        await startRustProxy()
    }

    const response = await fetch(`http://127.0.0.1:${RUST_PROXY_PORT}/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, project, access_token: accessToken, request }),
    })

    return response.json()
}

// No process management needed - start.command handles lifecycle
export function stopRustProxy(): void {
    // No-op - managed by start.command
}
