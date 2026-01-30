/**
 * 共享配额黑名单模块
 * 被 router.ts 和 account-manager.ts 共同使用
 * 用于记录配额耗尽的账户，避免重复选中无配额账户
 */

// "provider:accountId:model" -> expiry timestamp
const quotaBlacklist = new Map<string, number>()
const QUOTA_BLACKLIST_DURATION = 5 * 60 * 1000 // 5分钟

/**
 * 生成黑名单 key
 */
function getKey(provider: string, accountId: string, model: string): string {
    return `${provider}:${accountId}:${model}`
}

/**
 * 检查账户是否在配额黑名单中
 */
export function isQuotaBlacklisted(provider: string, accountId: string, model: string): boolean {
    const key = getKey(provider, accountId, model)
    const expiry = quotaBlacklist.get(key)
    if (!expiry) return false
    if (Date.now() > expiry) {
        quotaBlacklist.delete(key)
        return false
    }
    return true
}

/**
 * 将账户加入配额黑名单
 * @param durationMs 可选的自定义黑名单时长（毫秒）
 */
export function addToQuotaBlacklist(provider: string, accountId: string, model: string, durationMs?: number): void {
    const key = getKey(provider, accountId, model)
    const duration = durationMs ?? QUOTA_BLACKLIST_DURATION
    quotaBlacklist.set(key, Date.now() + duration)
    console.log(`[QuotaBlacklist] Added ${accountId}:${model} to blacklist for ${Math.ceil(duration / 1000)}s`)
}

/**
 * 从配额黑名单中移除账户
 */
export function removeFromQuotaBlacklist(provider: string, accountId: string, model: string): void {
    const key = getKey(provider, accountId, model)
    if (quotaBlacklist.delete(key)) {
        console.log(`[QuotaBlacklist] Removed ${accountId}:${model} from blacklist`)
    }
}

/**
 * 清除过期的黑名单条目（可选的维护函数）
 */
export function cleanupExpiredEntries(): number {
    const now = Date.now()
    let cleaned = 0
    for (const [key, expiry] of quotaBlacklist) {
        if (now > expiry) {
            quotaBlacklist.delete(key)
            cleaned++
        }
    }
    return cleaned
}

/**
 * 获取黑名单大小（用于调试）
 */
export function getBlacklistSize(): number {
    return quotaBlacklist.size
}
