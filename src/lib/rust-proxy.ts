/**
 * Rust Proxy Bridge
 * Owns the loopback Rust sidecar lifecycle and authenticates proxy requests.
 */

import { randomBytes } from "crypto"
import { existsSync } from "fs"
import { dirname, join } from "path"
import consola from "consola"

const RUST_PROXY_PORT = 8965
const RUST_PROXY_URL = `http://127.0.0.1:${RUST_PROXY_PORT}`
const SIDECAR_TOKEN_ENV = "ANTI_API_SIDECAR_TOKEN"
const SIDECAR_TOKEN_HEADER = "x-anti-api-sidecar-token"
const SIDECAR_START_ATTEMPTS = 40
const SIDECAR_START_DELAY_MS = 50

// Generated once per TypeScript parent process and reused for sidecar restarts.
const sidecarToken = randomBytes(32).toString("base64url")

let rustProxy: ReturnType<typeof Bun.spawn> | null = null
let proxyAvailable = false

function resolveRustProxyPath(): string | null {
    const binaryName = process.platform === "win32" ? "anti-proxy.exe" : "anti-proxy"
    const configuredPath = process.env.ANTI_API_RUST_PROXY_BIN?.trim()
    const candidates = [
        configuredPath,
        join(dirname(process.execPath), binaryName),
        join(import.meta.dir, "../../rust-proxy/target/release", binaryName),
        join(import.meta.dir, "../../rust-proxy/target/debug", binaryName),
    ]

    return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null
}

async function healthCheck(): Promise<boolean> {
    try {
        const response = await fetch(`${RUST_PROXY_URL}/health`, {
            method: "GET",
            signal: AbortSignal.timeout(250),
        })
        return response.ok && await response.text() === "OK"
    } catch {
        return false
    }
}

/**
 * Start the Rust sidecar and wait until it is accepting loopback requests.
 */
export async function startRustProxy(): Promise<void> {
    if (proxyAvailable && rustProxy?.exitCode === null) return

    stopRustProxy()

    const rustProxyPath = resolveRustProxyPath()
    if (!rustProxyPath) {
        throw new Error("Rust proxy binary not found")
    }

    const child = Bun.spawn([rustProxyPath], {
        env: {
            ...process.env,
            [SIDECAR_TOKEN_ENV]: sidecarToken,
        },
        stdout: "ignore",
        stderr: "ignore",
    })
    rustProxy = child

    void child.exited.then(() => {
        if (rustProxy === child) {
            rustProxy = null
            proxyAvailable = false
        }
    })

    for (let attempt = 0; attempt < SIDECAR_START_ATTEMPTS; attempt += 1) {
        if (child.exitCode !== null) break
        if (await healthCheck()) {
            proxyAvailable = true
            consola.success("🦀 Started Rust proxy on port", RUST_PROXY_PORT)
            return
        }
        await Bun.sleep(SIDECAR_START_DELAY_MS)
    }

    stopRustProxy()
    throw new Error("Rust proxy failed to start")
}

/**
 * Check if the managed Rust proxy process is ready.
 */
export function isRustProxyReady(): boolean {
    return proxyAvailable && rustProxy?.exitCode === null
}

export interface RustProxyResponse {
    success: boolean
    data?: string
    error?: string
    status_code?: number
}

/**
 * Send a request through the Rust proxy.
 */
export async function sendViaRustProxy(
    model: string,
    project: string,
    accessToken: string,
    request: unknown
): Promise<RustProxyResponse> {
    if (!isRustProxyReady()) {
        await startRustProxy()
    }

    try {
        const response = await fetch(`${RUST_PROXY_URL}/proxy`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                [SIDECAR_TOKEN_HEADER]: sidecarToken,
            },
            body: JSON.stringify({ model, project, access_token: accessToken, request }),
        })

        return await response.json() as RustProxyResponse
    } catch (error) {
        proxyAvailable = false
        throw error
    }
}

export function stopRustProxy(): void {
    const child = rustProxy
    rustProxy = null
    proxyAvailable = false
    if (!child || child.exitCode !== null) return

    try {
        child.kill()
    } catch {
        // Ignore shutdown errors from child cleanup.
    }
}
