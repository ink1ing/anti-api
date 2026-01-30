/**
 * Application Constants
 * Centralized configuration values to avoid magic numbers
 */

import { platform, arch } from "os"

// ============================================
// Version & User-Agent Constants
// ============================================

/** 
 * Antigravity client version - FALLBACK value
 * 
 * 优先使用 version-fetcher.ts 中的自动获取功能
 * 此值仅作为网络请求失败时的后备
 * 
 * 如需手动更新，参考: https://marketplace.visualstudio.com/items?itemName=Google.geminicodeassist
 */
export const ANTIGRAVITY_FALLBACK_VERSION = "1.15.8"

/** Build User-Agent string dynamically based on current platform (同步版本，使用 fallback) */
export function getAntigravityUserAgent(): string {
    const os = platform()
    const architecture = arch()
    return `antigravity/${ANTIGRAVITY_FALLBACK_VERSION} ${os}/${architecture}`
}

/** Static User-Agent for environments that can't call functions (e.g., Rust) */
export const ANTIGRAVITY_USER_AGENT_STATIC = `antigravity/${ANTIGRAVITY_FALLBACK_VERSION} windows/amd64`

// ============================================
// Time Constants (in milliseconds)
// ============================================

/** One second in milliseconds */
export const ONE_SECOND_MS = 1000

/** One minute in milliseconds */
export const ONE_MINUTE_MS = 60 * 1000

/** Default rate limit cooldown period */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000

/** Minimum interval between API requests */
export const MIN_REQUEST_INTERVAL_MS = 1000

/** Token refresh buffer - refresh if expiring within this time */
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

/** OAuth authentication timeout */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

/** Tunnel status check interval */
export const TUNNEL_CHECK_INTERVAL_MS = 60_000

/** Quota fetch retry delay */
export const QUOTA_RETRY_DELAY_MS = 1000

// ============================================
// Retry Constants
// ============================================

/** Maximum retry attempts for API calls */
export const MAX_RETRY_ATTEMPTS = 5

/** Base delay for exponential backoff */
export const EXPONENTIAL_BACKOFF_BASE_MS = 1000

/** Maximum delay for exponential backoff */
export const EXPONENTIAL_BACKOFF_MAX_MS = 8000

// ============================================
// Limits
// ============================================

/** Maximum messages per request */
export const MAX_MESSAGES_PER_REQUEST = 1000

/** Maximum tools per request */
export const MAX_TOOLS_PER_REQUEST = 100

/** Maximum model name length */
export const MAX_MODEL_NAME_LENGTH = 256

/** Maximum account ID length */
export const MAX_ACCOUNT_ID_LENGTH = 256

/** Maximum string length for sanitization */
export const MAX_SANITIZED_STRING_LENGTH = 10000

/** Maximum max_tokens value */
export const MAX_TOKENS_LIMIT = 1000000

// ============================================
// Rate Limit Durations
// ============================================

/** Rate limit tiers based on error type */
export const RATE_LIMIT_TIERS = {
    /** Generic 429 - 1 minute */
    GENERIC: 60_000,
    /** Quota exhausted (20-50%) - 5 minutes */
    QUOTA_LOW: 5 * 60_000,
    /** Quota critically low (<20%) - 30 minutes */
    QUOTA_CRITICAL: 30 * 60_000,
    /** Quota empty (0%) - 2 hours */
    QUOTA_EMPTY: 2 * 60 * 60_000,
} as const
