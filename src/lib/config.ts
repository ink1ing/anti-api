/**
 * Anti-API 配置
 * Antigravity API端点和模型映射
 */

// 默认端口
export const DEFAULT_PORT = 8964

// 支持的模型列表（用于/v1/models端点）
export const AVAILABLE_MODELS = [
    // Claude 4.5
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 (Thinking)" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-haiku-4-5-thinking", name: "Claude Haiku 4.5 (Thinking)" },
    { id: "claude-opus-4-5-thinking", name: "Claude Opus 4.5 (Thinking)" },

    // Claude 4
    { id: "claude-opus-4", name: "Claude 4 Opus" },
    { id: "claude-opus-4-thinking", name: "Claude 4 Opus (Thinking)" },
    { id: "claude-sonnet-4", name: "Claude 4 Sonnet" },
    { id: "claude-sonnet-4-thinking", name: "Claude 4 Sonnet (Thinking)" },

    // Gemini 3
    { id: "gemini-3-pro-high", name: "Gemini 3 Pro (High)" },
    { id: "gemini-3-pro-low", name: "Gemini 3 Pro (Low)" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },

    // Gemini 2.5
    { id: "gemini-2-5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2-5-flash", name: "Gemini 2.5 Flash" },

    // GPT-OSS
    { id: "gpt-oss-120b", name: "GPT-OSS 120B (Medium)" },
]
