import { fetchInsecureJson, getProjectID } from "./oauth"
import { generateMockProjectId } from "./project-id"
import { UpstreamError } from "~/lib/error"
import { getAntigravityUserAgent } from "~/lib/antigravity-client"

const CLOUD_CODE_BASE_URL = "https://cloudcode-pa.googleapis.com"
const USER_AGENT = getAntigravityUserAgent()

export type AntigravityModelInfo = {
    remainingFraction?: number
    resetTime?: string
}

export async function fetchAntigravityModels(
    accessToken: string,
    projectId?: string | null
): Promise<{ models: Record<string, AntigravityModelInfo>; projectId: string | null }> {
    const resolvedProjectId = projectId || await getProjectID(accessToken) || generateMockProjectId()
    const project = resolvedProjectId

    const response = await fetchInsecureJson(`${CLOUD_CODE_BASE_URL}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ project }),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new UpstreamError("antigravity", response.status, response.text)
    }

    const data = response.data as { models?: Record<string, { quotaInfo?: AntigravityModelInfo }> }

    const models: Record<string, AntigravityModelInfo> = {}
    for (const [name, info] of Object.entries(data.models || {})) {
        models[name] = {
            remainingFraction: info.quotaInfo?.remainingFraction ?? 0,
            resetTime: info.quotaInfo?.resetTime,
        }
    }

    return {
        models,
        projectId: resolvedProjectId || null,
    }
}

function toTimestamp(value: string): number | null {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

export function pickResetTime(
    models: Record<string, AntigravityModelInfo>,
    modelId?: string
): string | null {
    if (modelId) {
        const candidate = models[modelId]?.resetTime
        if (candidate && toTimestamp(candidate) !== null) {
            return candidate
        }
    }

    let best: { value: string; ms: number } | null = null
    for (const info of Object.values(models)) {
        if (!info?.resetTime) continue
        const ms = toTimestamp(info.resetTime)
        if (ms === null) continue
        if (!best || ms < best.ms) {
            best = { value: info.resetTime, ms }
        }
    }

    return best ? best.value : null
}
