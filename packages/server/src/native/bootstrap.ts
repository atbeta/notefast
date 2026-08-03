/**
 * NoteFast 内嵌 server 引导入口（原生客户端专用）
 *
 * 与 index.ts（Web CLI / Docker）的区别：
 * - 命令行参数优先：`--data-dir` / `--port 0` / `--assets-dir`（而非只读环境变量）
 * - 只监听 127.0.0.1（绝不对外暴露）；开启 trustedLocal——回环请求跳过 token/密码校验
 * - **stdout 是机器握手通道**：常规日志全部重定向到 stderr，启动成功后向 stdout
 *   写一行 `NF_READY <json>`（Swift/Tauri 壳读取 port/version/notebookId），
 *   其余 stdout 输出一律视为噪声（客户端按 NF_READY 前缀扫描即可容错）
 * - 引擎资源（VERSION / native/vec0 / libsqlite3 / web-dist）随产物分发，
 *   通过 `--assets-dir` 或 `dirname(process.execPath)` 定位并显式注入 env——
 *   编译单文件里 `process.argv[1]` / `import.meta.dir` 解析到 `/$bunfs/root/`
 *   虚拟路径，不可用于磁盘定位；`--define` 注入 `process.env.*` 亦不生效
 *
 * 编译：`bun build src/native/bootstrap.ts --compile`（见 scripts/build-engine.ts）
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createApp } from '../app'
import { closeAllSseStreams } from '../api/events'

// ───────────────────── stdout = 协议通道 ─────────────────────
const writeStdout = process.stdout.write.bind(process.stdout)
console.log = (...a) => console.error('[log]', ...a)
console.info = (...a) => console.error('[info]', ...a)

function vecSuffix(): string {
  if (process.platform === 'darwin') return 'dylib'
  if (process.platform === 'win32') return 'dll'
  return 'so'
}

export interface NativeArgs {
  dataDir: string
  /** 0 = 随机端口（由 Bun.serve 分配，握手行回传实际端口） */
  port: number
  /** 引擎资源根目录：缺省为可执行文件所在目录 */
  assetsDir: string
}

function usage(): string {
  return [
    '用法: notefast-server [选项]',
    '  --data-dir <path>   数据目录（SQLite + media + 配置）[env DATA_DIR]',
    '  --port <n>          监听端口；0 = 随机（默认）',
    '  --assets-dir <path> 引擎资源根目录（VERSION / native/ / web-dist）[默认: 可执行文件目录]',
    '  -h, --help          显示帮助',
    '',
    '启动成功后向 stdout 写一行: NF_READY <json>（{"port","version","notebookId",...}）',
  ].join('\n')
}

export function parseNativeArgs(argv: string[]): NativeArgs {
  const args: NativeArgs = {
    dataDir: process.env.DATA_DIR || './data',
    port: 0,
    assetsDir: dirname(process.execPath),
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const takeValue = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`参数 ${flag} 缺少值`)
      return v
    }
    switch (flag) {
      case '--data-dir':
        args.dataDir = takeValue()
        break
      case '--port': {
        const p = Number(takeValue())
        if (!Number.isInteger(p) || p < 0 || p > 65535) {
          throw new Error(`--port 非法: ${argv[i]}`)
        }
        args.port = p
        break
      }
      case '--assets-dir':
        args.assetsDir = takeValue()
        break
      case '-h':
      case '--help':
        console.error(usage())
        process.exit(0)
        break
      default:
        throw new Error(`未知参数: ${flag}\n\n${usage()}`)
    }
  }
  return args
}

/** 将引擎资源路径注入 env（创建 app 前调用；资源缺失时保留既有解析逻辑） */
export function injectEngineAssets(args: NativeArgs): void {
  process.env.DATA_DIR = args.dataDir

  const versionFile = join(args.assetsDir, 'VERSION')
  if (!process.env.APP_VERSION && existsSync(versionFile)) {
    process.env.APP_VERSION = readFileSync(versionFile, 'utf-8').trim()
  }
  const vec = join(args.assetsDir, 'native', `vec0.${vecSuffix()}`)
  if (existsSync(vec)) process.env.SQLITE_VEC_PATH = vec
  const sqliteLib = join(args.assetsDir, 'libsqlite3.dylib')
  if (existsSync(sqliteLib)) process.env.SQLITE_LIBRARY_PATH = sqliteLib
  const webDist = join(args.assetsDir, 'web-dist')
  if (existsSync(webDist)) process.env.WEB_DIST = webDist
}

async function main(): Promise<void> {
  let args: NativeArgs
  try {
    args = parseNativeArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
    return
  }

  injectEngineAssets(args)

  const handle = createApp({ dataDir: args.dataDir, trustedLocal: true })
  await handle.start()

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: args.port,
    fetch: handle.app.fetch,
  })
  handle.attachServer(server)

  writeStdout(
    'NF_READY '
      + JSON.stringify({
        port: server.port,
        version: handle.version,
        notebookId: handle.notebookId,
        apiPath: '/api/v1',
        mcpPath: '/mcp',
      })
      + '\n',
  )

  // 优雅停机：与 index.ts 同语义——SIGTERM 停止接收新连接、等在飞请求 drain，
  // 超时强退；DB 清理由 createApp 注册的 process.on('exit') 统一完成。
  const SHUTDOWN_TIMEOUT_MS = 10_000
  let shuttingDown = false
  function shutdown(signal: string): void {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[bootstrap] 收到 ${signal}，停止接收新连接，等待在飞请求完成…`)
    // 主动关闭 SSE 订阅流（/api/v1/events 是永久长连接），否则 drain 会等满强退超时
    try { closeAllSseStreams() } catch { /* ignore */ }
    const forceTimer = setTimeout(() => {
      console.error(`[bootstrap] ${SHUTDOWN_TIMEOUT_MS}ms 内未能 drain，强制退出`)
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceTimer.unref()
    void server.stop(false).then(() => {
      clearTimeout(forceTimer)
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// 仅作为入口模块时启动（被测试 import 时只导出纯函数，不产生副作用）
if (import.meta.main) {
  await main()
}
