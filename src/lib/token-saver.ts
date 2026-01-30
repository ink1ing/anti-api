/**
 * Token Saver - 智能识别后台任务并重定向到免费模型
 *
 * 检测 Claude Code 后台任务（标题生成、摘要、prompt 建议等），
 * 将这些低价值请求重定向到免费模型，节省付费配额。
 */

import type { ClaudeMessage } from "~/lib/translator"

// 目标免费模型
export const TOKEN_SAVER_MODEL = "gemini-2.5-flash"

// 后台任务检测模式
const BACKGROUND_TASK_PATTERNS: RegExp[] = [
    // 标题生成
    /write a (?:\d+-?\d* word )?title/i,
    /\b\d+-\d+ word title\b/i,
    /generate (?:a )?(?:short )?title/i,

    // 摘要生成
    /concise summary/i,
    /summarize (?:the )?(?:conversation|chat|discussion)/i,
    /brief summary/i,

    // Prompt 建议
    /prompt suggestion/i,
    /next prompt/i,
    /follow-up (?:questions?|prompts?)/i,
    /suggest(?:ed)? (?:next )?(?:questions?|prompts?)/i,

    // 自动补全相关
    /autocomplete/i,
    /code completion suggestion/i,
]

/**
 * 从 messages 中提取最后一条 user 消息的文本内容
 */
function extractLastUserMessage(messages: ClaudeMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                return msg.content
            }
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter((block: any) => block.type === "text" && block.text)
                    .map((block: any) => block.text)
                return textParts.join("\n")
            }
        }
    }
    return ""
}

/**
 * 从 messages 中提取 system prompt（如果存在）
 */
function extractSystemPrompt(messages: ClaudeMessage[]): string {
    for (const msg of messages) {
        if (msg.role === "system") {
            if (typeof msg.content === "string") {
                return msg.content
            }
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter((block: any) => block.type === "text" && block.text)
                    .map((block: any) => block.text)
                return textParts.join("\n")
            }
        }
    }
    return ""
}

/**
 * 检测是否为后台任务
 */
export function isBackgroundTask(messages: ClaudeMessage[]): boolean {
    // 检查最后一条用户消息
    const lastUserMessage = extractLastUserMessage(messages)
    if (lastUserMessage) {
        for (const pattern of BACKGROUND_TASK_PATTERNS) {
            if (pattern.test(lastUserMessage)) {
                return true
            }
        }
    }

    // 也检查 system prompt，某些后台任务可能通过 system prompt 触发
    const systemPrompt = extractSystemPrompt(messages)
    if (systemPrompt) {
        for (const pattern of BACKGROUND_TASK_PATTERNS) {
            if (pattern.test(systemPrompt)) {
                return true
            }
        }
    }

    return false
}

export interface TokenSaverResult {
    shouldRedirect: boolean
    targetModel: string
    reason?: string
}

/**
 * 应用 Token Saver 策略
 *
 * @param model 原始请求的模型
 * @param messages 请求的消息列表
 * @param enabled 是否启用 Token Saver
 * @returns Token Saver 结果
 */
export function applyTokenSaver(
    model: string,
    messages: ClaudeMessage[],
    enabled: boolean
): TokenSaverResult {
    // 未启用时直接返回
    if (!enabled) {
        return { shouldRedirect: false, targetModel: model }
    }

    // 如果已经是免费模型，不需要重定向
    if (model.toLowerCase().includes("gemini")) {
        return { shouldRedirect: false, targetModel: model }
    }

    // 检测后台任务
    if (isBackgroundTask(messages)) {
        return {
            shouldRedirect: true,
            targetModel: TOKEN_SAVER_MODEL,
            reason: "background_task"
        }
    }

    return { shouldRedirect: false, targetModel: model }
}
