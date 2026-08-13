import { homedir } from "os"

const SENSITIVE_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|cookie|oauth[-_]?(code|state))/gi
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g
const EMAIL = /\b([A-Z0-9._%+-])([A-Z0-9._%+-]*)(@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi

export function redactSensitiveText(input: string): string {
    let value = String(input)
    value = value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    value = value.replace(JWT, "[REDACTED_JWT]")
    value = value.replace(new RegExp(`(["']?${SENSITIVE_KEY.source}["']?\\s*[:=]\\s*["']?)([^"'\\s,&}]+)`, "gi"), "$1[REDACTED]")
    value = value.replace(/([?&](?:code|state|token|api_key|access_token|refresh_token)=)[^&#\s]+/gi, "$1[REDACTED]")
    value = value.replace(EMAIL, (_match, first: string, middle: string, domain: string) => `${first}${middle ? "***" : ""}${domain}`)
    const home = homedir()
    if (home && home !== "/") value = value.split(home).join("~")
    return value.slice(0, 4000)
}

export function safeErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error || "Internal error")
    return redactSensitiveText(raw).slice(0, 300)
}
