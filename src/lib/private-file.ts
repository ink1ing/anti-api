import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs"
import { dirname } from "path"

export function ensurePrivateDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") {
        try { chmodSync(dir, 0o700) } catch { }
    }
}

export function tightenPrivateFile(file: string): void {
    if (process.platform === "win32" || !existsSync(file)) return
    try { chmodSync(file, 0o600) } catch { }
}

export function writePrivateFile(file: string, data: string | Uint8Array): void {
    ensurePrivateDir(dirname(file))
    const temporary = `${file}.tmp-${process.pid}`
    try {
        writeFileSync(temporary, data, { mode: 0o600 })
        tightenPrivateFile(temporary)
        renameSync(temporary, file)
        tightenPrivateFile(file)
    } catch (error) {
        try { rmSync(temporary, { force: true }) } catch { }
        throw error
    }
}
