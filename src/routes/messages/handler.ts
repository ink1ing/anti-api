/**
 * /v1/messages 端点处理器
 * 将Anthropic格式请求转换为Antigravity调用
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { createChatCompletion, createChatCompletionStream, type ChatMessage } from "~/services/antigravity/chat"
import type {
    AnthropicMessagesPayload,
    AnthropicMessage,
    AnthropicResponse,
    AnthropicTextBlock,
    AnthropicContentBlock,
} from "./types"

/**
 * 将Anthropic消息转换为内部格式
 */
function translateMessages(payload: AnthropicMessagesPayload): ChatMessage[] {
    const messages: ChatMessage[] = []

    // 处理system消息
    if (payload.system) {
        const systemText = typeof payload.system === "string"
            ? payload.system
            : payload.system.map(b => b.text).join("\n")
        messages.push({ role: "system", content: systemText })
    }

    // 处理对话消息
    for (const msg of payload.messages) {
        const content = extractTextContent(msg)
        messages.push({ role: msg.role, content })
    }

    return messages
}

/**
 * 提取消息文本内容
 */
function extractTextContent(message: AnthropicMessage): string {
    if (typeof message.content === "string") {
        return message.content
    }

    return message.content
        .filter((block): block is AnthropicTextBlock => block.type === "text")
        .map(block => block.text)
        .join("\n")
}

/**
 * 生成响应ID
 */
function generateMessageId(): string {
    return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * 处理非流式请求
 */
export async function handleCompletion(c: Context): Promise<Response> {
    const payload = await c.req.json<AnthropicMessagesPayload>()
    consola.debug("Anthropic request:", JSON.stringify(payload).slice(0, 500))

    const messages = translateMessages(payload)

    // 检查是否流式
    if (payload.stream) {
        return handleStreamCompletion(c, payload, messages)
    }

    // 非流式请求
    const result = await createChatCompletion({
        model: payload.model,
        messages,
        maxTokens: payload.max_tokens,
    })

    const response: AnthropicResponse = {
        id: generateMessageId(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: result.content }],
        model: payload.model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
            input_tokens: result.usage?.inputTokens || 0,
            output_tokens: result.usage?.outputTokens || 0,
        },
    }

    consola.debug("Anthropic response:", JSON.stringify(response).slice(0, 500))
    return c.json(response)
}

/**
 * 处理流式请求
 */
async function handleStreamCompletion(
    c: Context,
    payload: AnthropicMessagesPayload,
    messages: ChatMessage[]
): Promise<Response> {
    const messageId = generateMessageId()

    return streamSSE(c, async (stream) => {
        // message_start 事件
        await stream.writeSSE({
            event: "message_start",
            data: JSON.stringify({
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: payload.model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            }),
        })

        // content_block_start 事件
        await stream.writeSSE({
            event: "content_block_start",
            data: JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            }),
        })

        // 调用Antigravity API获取流式响应
        try {
            const chatStream = createChatCompletionStream({
                model: payload.model,
                messages,
                stream: true,
                maxTokens: payload.max_tokens,
            })

            let totalOutputTokens = 0

            for await (const chunk of chatStream) {
                // 发送 content_block_delta
                await stream.writeSSE({
                    event: "content_block_delta",
                    data: JSON.stringify({
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "text_delta", text: chunk },
                    }),
                })
                totalOutputTokens += 1 // 简单估计
            }

            // content_block_stop 事件
            await stream.writeSSE({
                event: "content_block_stop",
                data: JSON.stringify({
                    type: "content_block_stop",
                    index: 0,
                }),
            })

            // message_delta 事件
            await stream.writeSSE({
                event: "message_delta",
                data: JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: totalOutputTokens },
                }),
            })

            // message_stop 事件
            await stream.writeSSE({
                event: "message_stop",
                data: JSON.stringify({ type: "message_stop" }),
            })

        } catch (error) {
            consola.error("Stream error:", error)
            await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                    type: "error",
                    error: { type: "api_error", message: (error as Error).message },
                }),
            })
        }
    })
}
