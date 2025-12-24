/**
 * Quota Service - 用量监控
 * 从 antigravity-quota-watcher 插件学习的 API
 */

import { state } from "../lib/state"
import consola from "consola"
import https from "https"

const GET_USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus"
const GET_MODEL_CONFIGS_PATH = "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs"

interface ModelQuota {
    label: string
    modelId: string
    remainingPercentage: number
    isExhausted: boolean
    resetTime: Date
}

interface QuotaSnapshot {
    timestamp: Date
    promptCredits?: {
        available: number
        monthly: number
        usedPercentage: number
        remainingPercentage: number
    }
    models: ModelQuota[]
    planName?: string
}

// 最新的配额快照
let latestSnapshot: QuotaSnapshot | null = null

/**
 * 向 Language Server 发送请求
 */
async function makeRequest(path: string, body: object): Promise<any> {
    const port = state.languageServerPort
    const csrfToken = state.csrfToken

    if (!port) {
        throw new Error("Language Server port not available")
    }
    if (!csrfToken) {
        throw new Error("CSRF token not available")
    }

    const requestBody = JSON.stringify(body)

    return new Promise((resolve, reject) => {
        const options = {
            hostname: "127.0.0.1",
            port: port,
            path: path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(requestBody),
                "Connect-Protocol-Version": "1",
                "X-Codeium-Csrf-Token": csrfToken,
            },
            rejectUnauthorized: false,
            timeout: 5000,
        }

        const req = https.request(options, (res) => {
            let data = ""
            res.on("data", (chunk) => { data += chunk })
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP error: ${res.statusCode}, body: ${data}`))
                    return
                }
                try {
                    resolve(JSON.parse(data))
                } catch {
                    reject(new Error(`Failed to parse response: ${data}`))
                }
            })
        })

        req.on("error", reject)
        req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")) })
        req.write(requestBody)
        req.end()
    })
}

/**
 * 获取用户状态和配额
 */
export async function getUserStatus(): Promise<QuotaSnapshot | null> {
    try {
        const response = await makeRequest(GET_USER_STATUS_PATH, {
            metadata: {
                ideName: "antigravity",
                extensionName: "antigravity",
                locale: "en",
            },
        })

        if (!response?.userStatus) {
            consola.warn("Invalid GetUserStatus response")
            return null
        }

        const userStatus = response.userStatus
        const planStatus = userStatus.planStatus
        const modelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || []

        // 解析 prompt credits
        const monthlyCredits = planStatus?.planInfo?.monthlyPromptCredits
        const availableCredits = planStatus?.availablePromptCredits

        const promptCredits = monthlyCredits && monthlyCredits > 0 && availableCredits !== undefined
            ? {
                available: Number(availableCredits),
                monthly: Number(monthlyCredits),
                usedPercentage: ((monthlyCredits - availableCredits) / monthlyCredits) * 100,
                remainingPercentage: (availableCredits / monthlyCredits) * 100,
            }
            : undefined

        // 解析模型配额
        const models: ModelQuota[] = modelConfigs
            .filter((config: any) => config.quotaInfo)
            .map((config: any) => {
                const quotaInfo = config.quotaInfo
                const remainingFraction = quotaInfo?.remainingFraction ?? 0
                const resetTime = new Date(quotaInfo.resetTime)

                return {
                    label: config.label,
                    modelId: config.modelOrAlias?.model || "unknown",
                    remainingPercentage: remainingFraction * 100,
                    isExhausted: remainingFraction === 0,
                    resetTime,
                }
            })

        const snapshot: QuotaSnapshot = {
            timestamp: new Date(),
            promptCredits,
            models,
            planName: planStatus?.planInfo?.planName,
        }

        latestSnapshot = snapshot
        return snapshot

    } catch (error) {
        consola.error("Failed to get user status:", error)
        return null
    }
}

/**
 * 获取最新的配额快照（不发请求）
 */
export function getLatestSnapshot(): QuotaSnapshot | null {
    return latestSnapshot
}

/**
 * 格式化配额为可读字符串
 */
export function formatQuotaStatus(): string {
    if (!latestSnapshot) {
        return "Quota: Unknown"
    }

    const lines: string[] = []

    // Plan Name
    if (latestSnapshot.planName) {
        lines.push(`📋 Plan: ${latestSnapshot.planName}`)
    }

    // Model Quotas
    for (const model of latestSnapshot.models) {
        const emoji = model.isExhausted ? "🔴" : model.remainingPercentage < 30 ? "🟡" : "🟢"
        lines.push(`${emoji} ${model.label}: ${model.remainingPercentage.toFixed(0)}%`)
    }

    lines.push(`\n📊 Total: ${latestSnapshot.models.length} models`)

    return lines.join("\n")
}
