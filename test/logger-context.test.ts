import { expect, test } from "bun:test"
import { getRequestLogContext, runWithRequestContext, setRequestLogContext } from "~/lib/logger"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("request log context is isolated per async scope", async () => {
    const [first, second] = await Promise.all([
        runWithRequestContext(async () => {
            setRequestLogContext({ model: "model-a", provider: "antigravity", account: "acc-a" })
            await delay(20)
            return getRequestLogContext()
        }),
        runWithRequestContext(async () => {
            setRequestLogContext({ model: "model-b", provider: "copilot", account: "acc-b" })
            await delay(5)
            return getRequestLogContext()
        }),
    ])

    expect(first.model).toBe("model-a")
    expect(first.account).toBe("acc-a")
    expect(second.model).toBe("model-b")
    expect(second.account).toBe("acc-b")
})
