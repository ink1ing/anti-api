/**
 * AccountSelector - Unified interface for account selection and rate limiting
 *
 * This module provides a single source of truth for:
 * - Account selection across providers (antigravity, codex, copilot)
 * - Rate limit state management
 * - Account availability checks
 */

import type { AuthProvider } from "~/services/auth/types"
import { accountManager } from "~/services/antigravity/account-manager"
import { authStore } from "~/services/auth/store"
import { isAccountDisabled } from "~/services/routing/config"

export interface RateLimitResult {
    reason: string
    durationMs: number
}

/**
 * Unified AccountSelector implementation
 * Delegates to accountManager for antigravity, authStore for codex/copilot
 */
class AccountSelectorImpl {
    /**
     * Check if an account is rate limited
     */
    isRateLimited(provider: AuthProvider, accountId: string): boolean {
        if (provider === "antigravity") {
            return accountManager.isAccountRateLimited(accountId)
        }
        return authStore.isRateLimited(provider, accountId)
    }

    /**
     * Check if account is currently processing a request (antigravity only)
     */
    isInFlight(provider: AuthProvider, accountId: string): boolean {
        if (provider === "antigravity") {
            return accountManager.isAccountInFlight(accountId)
        }
        return false
    }

    /**
     * Mark an account as rate limited
     */
    markRateLimited(provider: AuthProvider, accountId: string, durationMs: number): void {
        if (provider === "antigravity") {
            accountManager.markRateLimited(accountId, durationMs)
        } else {
            authStore.markRateLimited(provider, accountId, 429, `Rate limited for ${durationMs}ms`)
        }
    }

    /**
     * Mark an account rate limited based on error response
     */
    async markRateLimitedFromError(
        provider: AuthProvider,
        accountId: string,
        statusCode: number,
        errorText: string,
        retryAfterHeader?: string,
        modelId?: string,
        options?: { maxDurationMs?: number }
    ): Promise<RateLimitResult | null> {
        if (provider === "antigravity") {
            return accountManager.markRateLimitedFromError(
                accountId,
                statusCode,
                errorText,
                retryAfterHeader,
                modelId,
                options
            )
        }

        // For codex/copilot, use authStore
        authStore.markRateLimited(provider, accountId, statusCode, errorText, retryAfterHeader)
        return { reason: "rate_limited", durationMs: 60000 }
    }

    /**
     * Acquire a lock for an account (antigravity only)
     */
    async acquireLock(provider: AuthProvider, accountId: string): Promise<() => void> {
        if (provider === "antigravity") {
            return accountManager.acquireAccountLock(accountId)
        }
        // No locking for other providers
        return () => {}
    }

    /**
     * Move account to end of queue (antigravity only)
     */
    moveToEndOfQueue(provider: AuthProvider, accountId: string): void {
        if (provider === "antigravity") {
            accountManager.moveToEndOfQueue(accountId)
        }
    }

    /**
     * Get the rate limit expiry timestamp for an account
     */
    getRateLimitedUntil(provider: AuthProvider, accountId: string): number | null {
        if (provider === "antigravity") {
            return accountManager.getRateLimitedUntil(accountId)
        }

        // For codex/copilot, check authStore
        if (authStore.isRateLimited(provider, accountId)) {
            // authStore doesn't expose exact expiry, return a default
            return Date.now() + 60000
        }
        return null
    }

    /**
     * Mark account as successful (clears rate limit)
     */
    markSuccess(provider: AuthProvider, accountId: string): void {
        if (provider === "antigravity") {
            accountManager.markSuccess(accountId)
        }
        // authStore rate limits auto-expire, no explicit clear needed
    }

    /**
     * Get account display name for logging
     */
    getAccountDisplay(provider: AuthProvider, accountId: string): string {
        const account = authStore.getAccount(provider, accountId)
        if (provider === "antigravity") {
            return account?.email || account?.login || account?.label || accountId
        }
        return account?.login || account?.email || account?.label || accountId
    }

    /**
     * Check if account exists
     */
    hasAccount(provider: AuthProvider, accountId: string): boolean {
        if (provider === "antigravity") {
            return accountManager.hasAccount(accountId)
        }
        return !!authStore.getAccount(provider, accountId)
    }

    /**
     * Check if account is disabled
     */
    isDisabled(provider: AuthProvider, accountId: string): boolean {
        return isAccountDisabled(provider, accountId)
    }
}

// Export singleton instance
export const accountSelector = new AccountSelectorImpl()
