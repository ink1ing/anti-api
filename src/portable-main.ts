process.env.ANTI_API_PACKAGE_MANAGER = process.env.ANTI_API_PACKAGE_MANAGER || "winget"

await import("./packaged-main")

export {}
