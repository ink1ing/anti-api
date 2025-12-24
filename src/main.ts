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
        state.port = parseInt(args.port, 10)
        state.verbose = args.verbose

        if (args.verbose) {
            consola.level = 4 // debug
        }

        consola.info("Anti-API - Antigravity API Proxy")
        consola.info("================================")

        // 读取Antigravity token
        await setupAntigravityToken()

        // 获取language_server信息
        const lsInfo = await getLanguageServerInfo()
        if (lsInfo) {
            state.languageServerPort = lsInfo.port
            state.csrfToken = lsInfo.csrfToken
            consola.info(`Language Server: localhost:${lsInfo.port}`)
        } else {
            consola.warn("未找到运行中的Antigravity Language Server")
            consola.warn("请确保Antigravity应用正在运行")
        }

        // 启动服务器
        const port = state.port
        consola.info(`服务器启动在 http://localhost:${port}`)
        consola.info("")
        consola.info("Claude Code 使用方式:")
        consola.info(`  ANTHROPIC_BASE_URL=http://localhost:${port} \\`)
        consola.info("  ANTHROPIC_API_KEY=dummy \\")
        consola.info("  claude")

        Bun.serve({
            fetch: server.fetch,
            port,
        })
    },
})

const main = defineCommand({
    meta: {
        name: "anti-api",
        description: "Antigravity API Proxy - 将Antigravity内置大模型暴露为Anthropic兼容API",
    },
    subCommands: { start },
})

await runMain(main)
