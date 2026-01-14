/**
 * Anti-API 错误处理
 */

import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

export class HTTPError extends Error {
    response: Response

    constructor(message: string, response: Response) {
        super(message)
        this.response = response
    }
}

export class AntigravityError extends Error {
    code: string

    constructor(message: string, code: string = "antigravity_error") {
        super(message)
        this.code = code
    }
}

export class UpstreamError extends Error {
    status: number
    provider: string
    body: string
    retryAfter?: string

    constructor(provider: string, status: number, body: string, retryAfter?: string) {
        super(`${provider} upstream error (${status})`)
        this.status = status
        this.provider = provider
        this.body = body
        this.retryAfter = retryAfter
    }
}

function buildLogReason(error: unknown): string {
    if (error instanceof UpstreamError) {
        const body = (error.body || "").toLowerCase()
        if (error.status === 429) {
            if (body.includes("resource_exhausted") || body.includes("quota")) {
                return "quota exhausted"
            }
            return "rate limited"
        }
        if (error.status === 401) return "unauthorized"
        if (error.status === 403) return "forbidden"
        if (error.status === 404) return "not found"
        if (error.status >= 500) return "upstream error"
        return "upstream error"
    }

    if (error instanceof HTTPError) {
        return "http error"
    }

    if (error instanceof AntigravityError) {
        return error.code || "antigravity error"
    }

    return "internal error"
}

/**
 * 转发错误到客户端
 */
export async function forwardError(c: Context, error: unknown) {
    if (error instanceof HTTPError) {
        const errorText = await error.response.text()
        let errorJson: unknown
        try {
            errorJson = JSON.parse(errorText)
        } catch {
            errorJson = errorText
        }
        c.header("X-Log-Reason", buildLogReason(error))
        return c.json(
            {
                error: {
                    type: "error",
                    message: errorText,
                },
            },
            error.response.status as ContentfulStatusCode,
        )
    }

    if (error instanceof AntigravityError) {
        c.header("X-Log-Reason", buildLogReason(error))
        return c.json(
            {
                error: {
                    type: error.code,
                    message: error.message,
                },
            },
            500,
        )
    }

    if (error instanceof UpstreamError) {
        c.header("X-Log-Reason", buildLogReason(error))
        return c.json(
            {
                error: {
                    type: "upstream_error",
                    message: error.body || error.message,
                    provider: error.provider,
                },
            },
            error.status as ContentfulStatusCode,
        )
    }

    c.header("X-Log-Reason", buildLogReason(error))
    return c.json(
        {
            error: {
                type: "error",
                message: (error as Error).message,
            },
        },
        500,
    )
}
