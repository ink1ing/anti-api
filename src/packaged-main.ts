import { existsSync } from "fs"
import { dirname, join } from "path"

import { runCli } from "./main"
import { startRustProxy, stopRustProxy } from "./lib/rust-proxy"

const exeDir = dirname(process.execPath)
const publicDir = join(exeDir, "public")
const rustProxyName = process.platform === "win32" ? "anti-proxy.exe" : "anti-proxy"
const rustProxyPath = join(exeDir, rustProxyName)

process.env.ANTI_API_OAUTH_NO_OPEN = process.env.ANTI_API_OAUTH_NO_OPEN || "1"

if (!process.env.ANTI_API_PUBLIC_DIR && existsSync(publicDir)) {
    process.env.ANTI_API_PUBLIC_DIR = publicDir
}
if (!process.env.ANTI_API_RUST_PROXY_BIN && existsSync(rustProxyPath)) {
    process.env.ANTI_API_RUST_PROXY_BIN = rustProxyPath
}

process.on("SIGINT", () => {
    stopRustProxy()
    process.exit(130)
})

process.on("SIGTERM", () => {
    stopRustProxy()
    process.exit(143)
})

if (existsSync(rustProxyPath)) {
    await startRustProxy()
}

try {
    const rawArgs = process.argv.slice(2)
    await runCli(rawArgs.length > 0 ? rawArgs : ["start"])
} finally {
    stopRustProxy()
}
