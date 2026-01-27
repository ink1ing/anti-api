/**
 * Anti-API 配置
 * Antigravity API端点和模型映射
 */

// 默认端口
export const DEFAULT_PORT = 8964

// 支持的模型列表（用于/v1/models端点）
export const AVAILABLE_MODELS = [
    // ==================== Claude 系列 ====================
    // Claude 4.5 系列
    { id: "claude-opus-4-5-thinking", name: "Claude Opus 4.5 (Thinking)" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 (Thinking)" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-haiku-4-5-thinking", name: "Claude Haiku 4.5 (Thinking)" },

    // Claude 4 系列
    { id: "claude-opus-4", name: "Claude Opus 4" },
    { id: "claude-opus-4-thinking", name: "Claude Opus 4 (Thinking)" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "claude-sonnet-4-thinking", name: "Claude Sonnet 4 (Thinking)" },

    // ==================== Gemini 系列 ====================
    // Gemini 3 系列
    { id: "gemini-3-pro-high", name: "Gemini 3 Pro (High)" },
    { id: "gemini-3-pro-low", name: "Gemini 3 Pro (Low)" },
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },

    // Gemini 3 Pro Image 系列 (图像生成)
    { id: "gemini-3-pro-image", name: "Gemini 3 Pro Image" },
    { id: "gemini-3-pro-image-2k", name: "Gemini 3 Pro Image (2K)" },
    { id: "gemini-3-pro-image-4k", name: "Gemini 3 Pro Image (4K)" },
    { id: "gemini-3-pro-image-1x1", name: "Gemini 3 Pro Image (1:1)" },
    { id: "gemini-3-pro-image-4x3", name: "Gemini 3 Pro Image (4:3)" },
    { id: "gemini-3-pro-image-3x4", name: "Gemini 3 Pro Image (3:4)" },
    { id: "gemini-3-pro-image-16x9", name: "Gemini 3 Pro Image (16:9)" },
    { id: "gemini-3-pro-image-9x16", name: "Gemini 3 Pro Image (9:16)" },
    { id: "gemini-3-pro-image-21x9", name: "Gemini 3 Pro Image (21:9)" },

    // Gemini 2.5 系列
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-thinking", name: "Gemini 2.5 Flash (Thinking)" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },

    // Gemini 2.0 系列
    { id: "gemini-2.0-flash-exp", name: "Gemini 2.0 Flash (Experimental)" },

    // ==================== GPT-OSS 系列 ====================
    { id: "gpt-oss-120b", name: "GPT-OSS 120B (Medium)" },
]
