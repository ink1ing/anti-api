const ADJECTIVES = ["useful", "bright", "swift", "calm", "bold"]
const NOUNS = ["fuze", "wave", "spark", "flow", "core"]

function randomChoice(values: string[]): string {
    return values[Math.floor(Math.random() * values.length)]
}

function randomBase36(length: number): string {
    let out = ""
    while (out.length < length) {
        out += Math.floor(Math.random() * 36).toString(36)
    }
    return out.slice(0, length)
}

export function generateMockProjectId(): string {
    const adjective = randomChoice(ADJECTIVES)
    const noun = randomChoice(NOUNS)
    const suffix = randomBase36(5)
    return `${adjective}-${noun}-${suffix}`
}
