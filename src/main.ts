#!/usr/bin/env bun
/**
 * Anti-API 入口
 * 将Antigravity内置大模型暴露为Anthropic兼容API
 */

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { server } from "./server"
import { setupAntigravityToken } from "./lib/token"
import { getLanguageServerInfo } from "./lib/port-finder"
import { state } from "./lib/state"
import { initAuth, isAuthenticated, saveAuth, startOAuthLogin } from "./services/antigravity/login"
import { getProjectID } from "./services/antigravity/oauth"
import { accountManager } from "./services/antigravity/account-manager"

/**
 * 打开浏览器
 */
function openBrowser(url: string): void {
    const platform = process.platform
    let cmd: string
    let args: string[]

    if (platform === "darwin") {
        cmd = "open"
        args = [url]
    } else if (platform === "win32") {
        cmd = "cmd"
        args = ["/c", "start", url]
    } else {
        cmd = "xdg-open"
        args = [url]
    }

    Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" })
}

const start = defineCommand({
    meta: {
        name: "start",
        description: "启动Anti-API服务器",
    },
    args: {
        port: {
            type: "string",
            default: "8964",
            description: "监听端口",
            alias: "p",
        },
        verbose: {
            type: "boolean",
            default: false,
            description: "详细日志",
            alias: "v",
        },
    },
    async run({ args }) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
        state.port = parseInt(args.port, 10)
        state.verbose = args.verbose

        if (args.verbose) {
            consola.level = 4 // debug
        } else {
            consola.level = 0 // silent
        }

        // 尝试加载已保存的 OAuth 认证
        initAuth()

        // 如果没有 OAuth 认证，尝试从本地 IDE 读取 token（作为 fallback）
        if (!state.accessToken) {
            consola.info("未找到 OAuth 认证，尝试从本地 Antigravity IDE 读取...")
            try {
                await setupAntigravityToken()
            } catch (error) {
                consola.debug("无法从 IDE 读取 token:", (error as Error).message)
            }
        }

        // 刷新 Project ID（用于 cloudcode-pa 正确计费/配额）
        if (state.accessToken) {
            try {
                const projectId = await getProjectID(state.accessToken)
                if (projectId && projectId !== state.cloudaicompanionProject) {
                    state.cloudaicompanionProject = projectId
                    saveAuth()
                    consola.success(`Project ID refreshed: ${projectId}`)
                }
            } catch (error) {
                consola.debug("Project ID refresh failed:", (error as Error).message)
            }
        }

        // 获取 language_server 信息 (用于配额查询等)
        const lsInfo = await getLanguageServerInfo()
        if (lsInfo) {
            state.languageServerPort = lsInfo.port
            state.csrfToken = lsInfo.csrfToken
        }

        // 启动服务器
        Bun.serve({
            fetch: server.fetch,
            port: state.port,
            idleTimeout: 120,  // 2分钟超时，适应慢速 API 响应
        })

        if (args.verbose) {
            consola.success(`端口: http://localhost:${state.port}`)
            consola.success(`面板: http://localhost:${state.port}/quota`)
        }

        // 如果未登录，自动弹出登录窗口
        if (!isAuthenticated()) {
            if (args.verbose) {
                consola.info("未检测到登录状态，正在打开浏览器进行 OAuth 登录...")
            }
            const result = await startOAuthLogin()
            if (result.success) {
                if (args.verbose) {
                    consola.success(`登录成功: ${result.email}`)
                }
                // 登录成功后打开面板
                openBrowser(`http://localhost:${state.port}/quota`)
            } else {
                if (args.verbose) {
                    consola.error(`登录失败: ${result.error}`)
                    consola.info("你可以稍后运行 'bun run src/main.ts login' 重新登录")
                }
            }
        } else {
            if (args.verbose) {
                consola.success(`已登录: ${state.userEmail}`)
            }
            // 已登录时自动打开面板
            openBrowser(`http://localhost:${state.port}/quota`)
        }
    },
})

// 添加账号命令 - 用于多账号轮换
const addAccount = defineCommand({
    meta: {
        name: "add-account",
        description: "添加额外的 Google 账号用于配额轮换",
    },
    async run() {
        consola.info("正在添加新账号...")
        consola.info("提示: 添加多个账号可以在配额耗尽时自动轮换，避免 429 错误")

        // 加载现有账号
        accountManager.load()
        const existingEmails = accountManager.getEmails()
        if (existingEmails.length > 0) {
            consola.info(`当前已有 ${existingEmails.length} 个账号:`)
            existingEmails.forEach((email, i) => consola.info(`  ${i + 1}. ${email}`))
        }

        // 开始 OAuth 登录
        const result = await startOAuthLogin()
        if (result.success) {
            // 保存到账号管理器
            accountManager.addAccount({
                id: state.userEmail || `account-${Date.now()}`,
                email: state.userEmail || "unknown",
                accessToken: state.accessToken!,
                refreshToken: state.refreshToken!,
                expiresAt: state.tokenExpiresAt || 0,
                projectId: state.cloudaicompanionProject,
            })

            consola.success(`账号添加成功: ${result.email}`)
            consola.info(`现在共有 ${accountManager.count()} 个账号可用于轮换`)
        } else {
            consola.error(`添加账号失败: ${result.error}`)
        }
    },
})

// 列出账号命令
const listAccounts = defineCommand({
    meta: {
        name: "accounts",
        description: "列出所有已添加的账号",
    },
    run() {
        accountManager.load()
        const emails = accountManager.getEmails()

        if (emails.length === 0) {
            consola.info("暂无已添加的账号")
            consola.info("使用 'bun run src/main.ts add-account' 添加账号")
            return
        }

        consola.info(`共有 ${emails.length} 个账号:`)
        emails.forEach((email, i) => {
            consola.info(`  ${i + 1}. ${email}`)
        })
    },
})

// Remote 命令 - 启动服务器并创建公共隧道
const remote = defineCommand({
    meta: {
        name: "remote",
        description: "启动Anti-API并创建公共访问隧道",
    },
    args: {
        port: {
            type: "string",
            default: "8964",
            description: "监听端口",
            alias: "p",
        },
        subdomain: {
            type: "string",
            default: "",
            description: "自定义子域名(可选)",
            alias: "s",
        },
    },
    async run({ args }) {
        const { spawn } = await import("child_process")

        state.port = parseInt(args.port, 10)
        state.verbose = true
        consola.level = 0

        // 初始化认证
        initAuth()
        await setupAntigravityToken()

        // 获取language_server信息 (用于配额查询)
        const lsInfo = await getLanguageServerInfo()
        if (lsInfo) {
            state.languageServerPort = lsInfo.port
            state.csrfToken = lsInfo.csrfToken
        }

        // 启动服务器
        Bun.serve({
            fetch: server.fetch,
            port: state.port,
            idleTimeout: 120,
        })

        consola.success(`Anti-API 本地服务已启动: http://localhost:${state.port}`)

        // 使用 ngrok 创建隧道
        consola.info("正在创建 ngrok 隧道...")

        const ngrok = spawn("ngrok", ["http", state.port.toString(), "--log", "stdout"], {
            stdio: ["ignore", "pipe", "pipe"]
        })

        // 等待 ngrok 启动并获取 URL（重试机制）
        let tunnelUrl = ""
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000))
            try {
                const apiRes = await fetch("http://localhost:4040/api/tunnels")
                const data = await apiRes.json() as any
                tunnelUrl = data.tunnels?.[0]?.public_url || ""
                if (tunnelUrl) {
                    state.publicUrl = tunnelUrl
                    break
                }
            } catch (e) {
                // 继续重试
            }
            consola.info(`等待 ngrok 启动... (${i + 1}/10)`)
        }

        if (tunnelUrl) {
            consola.box({
                title: "🌍 Anti-API 公共端点已就绪",
                message: `
公共 URL: ${tunnelUrl}

本地面板: http://localhost:${state.port}/quota
公共面板: ${tunnelUrl}/quota

API 端点: ${tunnelUrl}/v1/messages

✅ 直接可用，无需确认！
                `.trim(),
                style: {
                    borderColor: "green",
                }
            })
        } else {
            consola.error("ngrok 启动失败，请检查配置")
            process.exit(1)
        }

        ngrok.on("close", (code: number) => {
            consola.warn("ngrok 已关闭，退出码:", code)
            process.exit(0)
        })

        ngrok.on("error", (err: Error) => {
            consola.error("ngrok 启动失败:", err.message)
            process.exit(1)
        })

        // 保持进程运行
        process.on("SIGINT", () => {
            consola.info("正在关闭...")
            ngrok.kill()
            process.exit(0)
        })
    },
})

const main = defineCommand({
    meta: {
        name: "anti-api",
        description: "Antigravity API Proxy - 将Antigravity内置大模型暴露为Anthropic兼容API",
    },
    subCommands: { start, remote, "add-account": addAccount, accounts: listAccounts },
})

await runMain(main)
