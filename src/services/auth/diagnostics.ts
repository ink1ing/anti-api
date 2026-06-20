import { execFile } from "node:child_process"
import { accessSync, constants, existsSync, readdirSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { getDataDir } from "~/lib/data-dir"
import { authStore } from "./store"
import type { AuthProvider } from "./types"

type DiagnosticStatus = "pass" | "warn" | "fail"

export interface DiagnosticCheck {
    id: string
    provider?: AuthProvider | "system"
    status: DiagnosticStatus
    title: string
    detail: string
    command?: string
    output?: string
}

export interface DiagnosticReport {
    generatedAt: string
    checks: DiagnosticCheck[]
}

const PROVIDERS: AuthProvider[] = ["antigravity", "codex", "copilot", "zed", "kiro", "grok"]
const COMMAND_TIMEOUT_MS = 6000
const MAX_OUTPUT_LENGTH = 1000

function homePath(...parts: string[]): string {
    return join(process.env.HOME || process.env.USERPROFILE || homedir(), ...parts)
}

function redactOutput(value: string): string {
    return value
        .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, "[jwt-redacted]")
        .replace(/(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
        .slice(0, MAX_OUTPUT_LENGTH)
}

function fileSummary(path: string): string {
    if (!existsSync(path)) return "missing"
    try {
        const stat = statSync(path)
        if (stat.isDirectory()) return `directory (${stat.size} bytes metadata)`
        return `file (${stat.size} bytes)`
    } catch (error) {
        return `unreadable: ${(error as Error).message}`
    }
}

function countFiles(dir: string, predicate: (name: string) => boolean): number {
    if (!existsSync(dir)) return 0
    try {
        return readdirSync(dir).filter(predicate).length
    } catch {
        return 0
    }
}

function pushCheck(checks: DiagnosticCheck[], check: DiagnosticCheck): void {
    checks.push(check)
}

async function runShell(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
        execFile("/bin/zsh", ["-lc", command], { timeout: timeoutMs }, (error, stdout, stderr) => {
            const output = redactOutput(`${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim())
            resolve({ ok: !error, output })
        })
    })
}

async function commandCheck(
    checks: DiagnosticCheck[],
    id: string,
    provider: DiagnosticCheck["provider"],
    title: string,
    command: string,
    detailWhenOk: string,
    detailWhenFail: string,
    failStatus: DiagnosticStatus = "warn"
): Promise<void> {
    const result = await runShell(command)
    pushCheck(checks, {
        id,
        provider,
        status: result.ok && result.output ? "pass" : failStatus,
        title,
        detail: result.ok && result.output ? detailWhenOk : detailWhenFail,
        command,
        output: result.output || "(no output)",
    })
}

function dataDirDiagnostics(checks: DiagnosticCheck[]): void {
    const dataDir = getDataDir()
    let writable = false
    try {
        accessSync(dataDir, constants.R_OK | constants.W_OK)
        writable = true
    } catch {
        writable = false
    }
    pushCheck(checks, {
        id: "system.dataDir",
        provider: "system",
        status: writable ? "pass" : "fail",
        title: "Anti-API data directory",
        detail: writable
            ? `Readable and writable: ${dataDir}`
            : `Not readable/writable or missing: ${dataDir}. Account saves can fail until this is fixed.`,
    })

    const counts = PROVIDERS.map(provider => `${provider}:${authStore.listAccounts(provider).length}`).join(", ")
    pushCheck(checks, {
        id: "system.savedAccounts",
        provider: "system",
        status: "pass",
        title: "Saved account count",
        detail: counts,
    })
}

function pathDiagnostics(checks: DiagnosticCheck[]): void {
    const codexAuthPath = homePath(".codex", "auth.json")
    const proxyDir = homePath(".cli-proxy-api")
    const zedApp = "/Applications/Zed.app"
    const antigravityApp = "/Applications/Antigravity.app"
    const kiroJson = homePath(".aws", "sso", "cache", "kiro-auth-token.json")
    const kiroDb = homePath(".local", "share", "kiro-cli", "data.sqlite3")
    const amazonQDb = homePath(".local", "share", "amazon-q", "data.sqlite3")

    pushCheck(checks, {
        id: "antigravity.app",
        provider: "antigravity",
        status: existsSync(antigravityApp) ? "pass" : "warn",
        title: "Antigravity app",
        detail: `${antigravityApp}: ${fileSummary(antigravityApp)}`,
    })

    pushCheck(checks, {
        id: "codex.authFile",
        provider: "codex",
        status: existsSync(codexAuthPath) ? "pass" : "warn",
        title: "Codex CLI auth file",
        detail: `${codexAuthPath}: ${fileSummary(codexAuthPath)}`,
    })

    const codexProxyCount = countFiles(proxyDir, file => /^codex-.+\.json$/i.test(file))
    pushCheck(checks, {
        id: "codex.proxyFiles",
        provider: "codex",
        status: codexProxyCount > 0 ? "pass" : "warn",
        title: "Codex proxy auth files",
        detail: `${proxyDir}: ${codexProxyCount} codex auth file(s) found`,
    })

    const copilotProxyCount = countFiles(proxyDir, file => /^github-copilot-.+\.json$/i.test(file))
    pushCheck(checks, {
        id: "copilot.proxyFiles",
        provider: "copilot",
        status: copilotProxyCount > 0 ? "pass" : "warn",
        title: "GitHub Copilot local auth files",
        detail: `${proxyDir}: ${copilotProxyCount} GitHub Copilot auth file(s) found`,
    })

    pushCheck(checks, {
        id: "zed.app",
        provider: "zed",
        status: existsSync(zedApp) ? "pass" : "warn",
        title: "Zed app",
        detail: `${zedApp}: ${fileSummary(zedApp)}`,
    })

    const kiroSources = [
        { id: "kiro.json", path: kiroJson },
        { id: "kiro.db", path: kiroDb },
        { id: "kiro.amazonQDb", path: amazonQDb },
    ]
    const kiroFound = kiroSources.filter(source => existsSync(source.path))
    for (const source of kiroSources) {
        pushCheck(checks, {
            id: source.id,
            provider: "kiro",
            status: existsSync(source.path) ? "pass" : "warn",
            title: source.id === "kiro.json" ? "Kiro token cache" : source.id === "kiro.db" ? "Kiro CLI database" : "Amazon Q database",
            detail: `${source.path}: ${fileSummary(source.path)}`,
        })
    }
    pushCheck(checks, {
        id: "kiro.sources",
        provider: "kiro",
        status: kiroFound.length > 0 ? "pass" : "fail",
        title: "Kiro credential source",
        detail: kiroFound.length > 0
            ? `${kiroFound.length} possible Kiro credential source(s) found.`
            : "No Kiro credential source found. Sign in with Kiro IDE or run kiro-cli login first.",
    })
}

function envDiagnostics(checks: DiagnosticCheck[]): void {
    const redirect = process.env.ANTI_API_OAUTH_REDIRECT_URL
    pushCheck(checks, {
        id: "antigravity.redirect",
        provider: "antigravity",
        status: redirect ? "pass" : "pass",
        title: "Antigravity OAuth redirect",
        detail: redirect
            ? `Using override: ${redirect}`
            : "No override set. Anti-API will bind a local callback port starting at 1455.",
    })

    const kiroEnv = [
        "ANTI_API_KIRO_CREDS_FILE",
        "ANTI_API_KIRO_CLI_DB_FILE",
        "ANTI_API_KIRO_REGION",
        "ANTI_API_KIRO_ENDPOINT",
        "ANTI_API_KIRO_AUTH_ENDPOINT",
    ].filter(key => !!process.env[key])
    pushCheck(checks, {
        id: "kiro.env",
        provider: "kiro",
        status: kiroEnv.length > 0 ? "pass" : "warn",
        title: "Kiro environment overrides",
        detail: kiroEnv.length > 0 ? `Configured: ${kiroEnv.join(", ")}` : "No Kiro env overrides set; default local paths and us-east-1 will be used.",
    })
}

export async function runAccountDiagnostics(): Promise<DiagnosticReport> {
    const checks: DiagnosticCheck[] = []

    dataDirDiagnostics(checks)
    pathDiagnostics(checks)
    envDiagnostics(checks)

    await Promise.all([
        commandCheck(checks, "system.bun", "system", "Bun runtime", "bun --version", "Bun is available.", "Bun command is not available from this environment.", "warn"),
        commandCheck(checks, "codex.cli", "codex", "Codex CLI", "command -v codex && codex --version", "Codex CLI is available.", "Codex CLI is missing or not runnable. Browser OAuth may still work, but CLI import can fail.", "warn"),
        commandCheck(checks, "kiro.cli", "kiro", "Kiro CLI", "command -v kiro || command -v kiro-cli", "Kiro CLI is available.", "Kiro CLI was not found in PATH. Local Kiro IDE credentials may still be importable.", "warn"),
        commandCheck(checks, "zed.keychain", "zed", "Zed Keychain entry", "security find-internet-password -s zed.dev", "Zed Keychain entry is present.", "Zed Keychain entry was not found or access was denied. Open Zed and sign in first.", "warn"),
        commandCheck(checks, "antigravity.callbackPorts", "antigravity", "OAuth callback ports", "for p in {1455..1465}; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && echo \"$p:busy\" || echo \"$p:free\"; done", "Callback port scan completed.", "Could not scan callback ports.", "warn"),
    ])

    return {
        generatedAt: new Date().toISOString(),
        checks,
    }
}
