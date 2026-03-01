/**
 * Anti-API 配置
 * Antigravity API端点和模型映射
 */

// 默认端口
export const DEFAULT_PORT = 8964

// 支持的模型列表（用于/v1/models端点）
// 只显示 7 个配额面板可见且已确认可用的模型
export const AVAILABLE_MODELS = [
    // Claude 4.5 系列
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 (Thinking)" },
    { id: "claude-opus-4-5-thinking", name: "Claude Opus 4.5 (Thinking)" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },

    // Gemini 3 系列
    { id: "gemini-3-pro-high", name: "Gemini 3 Pro (High)" },
    { id: "gemini-3-pro-low", name: "Gemini 3 Pro (Low)" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },

    // GPT-OSS
    { id: "gpt-oss-120b", name: "GPT-OSS 120B (Medium)" },
]
