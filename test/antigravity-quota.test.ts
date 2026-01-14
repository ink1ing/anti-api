import { test, expect } from "bun:test"
import { pickResetTime } from "../src/services/antigravity/quota-fetch"

test("pickResetTime prefers explicit model reset time", () => {
    const models = {
        "model-a": { resetTime: "2025-01-02T00:00:00Z" },
        "model-b": { resetTime: "2025-01-01T00:00:00Z" },
    }

    expect(pickResetTime(models, "model-a")).toBe("2025-01-02T00:00:00Z")
})

test("pickResetTime falls back to earliest valid reset time", () => {
    const models = {
        "model-a": { resetTime: "not-a-date" },
        "model-b": { resetTime: "2025-01-03T00:00:00Z" },
        "model-c": { resetTime: "2025-01-01T12:00:00Z" },
    }

    expect(pickResetTime(models)).toBe("2025-01-01T12:00:00Z")
})
