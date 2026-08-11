/**
 * 构建「可内嵌 engine 产物」——原生客户端 / Tauri 壳的消费边界
 *
 * 客户端 = 版本快照：bundle 某个版本的 engine 产物，启动握手经 /api/v1/version 做兼容校验。
 * 产物布局（dist-engine/）：
 *   notefast-server              # bun build --compile 单文件可执行（内嵌 Bun 运行时 + 全部业务）
 *   native/vec0.<dylib|dll|so>   # sqlite-vec——编译单文件不内嵌可用 dylib，必须显式旁置并经 SQLITE_VEC_PATH
 *   libsqlite3.dylib             # macOS 专用：支持扩展加载的 SQLite（brew），经 SQLITE_LIBRARY_PATH
 *   web-dist/                    # 本脚本内先 bun run build web，再拷贝 vite 产物（勿复用陈旧 packages/web/dist）
 *   VERSION                      # 引擎版本（bootstrap 读它注入 APP_VERSION；编译产物里 import.meta.dir 失效）
 *   notefast-engine-<version>-<platform>.tar.gz
 *
 * 跨平台说明：bun --compile 只产出宿主平台可执行文件，本脚本在 CI 各平台 runner 上分别运行；
 * vec0 由 sqlite-vec 的 getLoadablePath() 定位（与 copy-sqlite-vec.ts 同源），libsqlite3 仅 darwin 拷贝。
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getLoadablePath } from 'sqlite-vec'

const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'))
const version = (process.env.APP_VERSION || pkg.version || '0.0.0').replace(/^v/, '')
const platform = process.platform // darwin / win32 / linux

const serverRoot = join(import.meta.dir, '..')
const outDir = join(serverRoot, 'dist-engine')
const execName = process.platform === 'win32' ? 'notefast-server.exe' : 'notefast-server'

function buildWeb(): void {
  const webRoot = join(serverRoot, '..', 'web')
  console.log('[engine] 构建 web（vite）…')
  const result = spawnSync('bun', ['run', 'build'], { cwd: webRoot, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`web build 失败（exit=${result.status}）`)
  }
}

function copyWebDist(): void {
  const src = join(serverRoot, '..', 'web', 'dist')
  if (!existsSync(src)) {
    throw new Error(`[engine] web-dist 缺失：${src}（buildWeb 应已产出）`)
  }
  cpSync(src, join(outDir, 'web-dist'), { recursive: true })
  console.log(`[engine] web-dist → dist-engine/web-dist/`)
}

function copySqliteVec(): void {
  const source = getLoadablePath()
  const ext = extname(source)
  const nativeDir = join(outDir, 'native')
  mkdirSync(nativeDir, { recursive: true })
  copyFileSync(source, join(nativeDir, `vec0${ext}`))
  console.log(`[engine] sqlite-vec → dist-engine/native/vec0${ext}`)
}

function copyMacSqlite(): void {
  if (process.platform !== 'darwin') return
  const candidates = [
    process.env.SQLITE_LIBRARY_PATH,
    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
    '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
  ].filter((p): p is string => Boolean(p))
  const library = candidates.find((p) => existsSync(p))
  if (!library) {
    console.warn('[engine] 跳过 libsqlite3.dylib：macOS 需支持扩展加载的 SQLite（brew install sqlite 或设 SQLITE_LIBRARY_PATH）')
    return
  }
  copyFileSync(library, join(outDir, 'libsqlite3.dylib'))
  console.log(`[engine] libsqlite3 → dist-engine/libsqlite3.dylib (${library})`)
}

function compile(): void {
  const result = spawnSync(
    process.execPath,
    ['build', 'src/native/bootstrap.ts', '--compile', '--outfile', join(outDir, execName), '--target=bun'],
    { cwd: serverRoot, stdio: 'inherit' },
  )
  if (result.status !== 0) {
    throw new Error(`bun build --compile 失败（exit=${result.status}）`)
  }
  console.log(`[engine] notefast-server${extname(execName)} → dist-engine/`)
}

function writeVersion(): void {
  writeFileSync(join(outDir, 'VERSION'), version + '\n', 'utf-8')
  console.log(`[engine] VERSION → ${version}`)
}

function archive(): void {
  if (process.platform === 'win32') {
    // Windows 10+ 自带 bsdtar；失败不阻断（产物目录已可用）
    const r = spawnSync('tar', ['-czf', archiveName(), execName, 'native', 'web-dist', 'VERSION'], {
      cwd: outDir,
      stdio: 'inherit',
    })
    if (r.status === 0) console.log(`[engine] ${archiveName()} 已生成`)
    else console.warn('[engine] tar 归档失败（产物目录仍可用）')
    return
  }
  const r = spawnSync('tar', ['-czf', archiveName(), execName, 'native', 'web-dist', 'VERSION', ...(process.platform === 'darwin' ? ['libsqlite3.dylib'] : [])], {
    cwd: outDir,
    stdio: 'inherit',
  })
  if (r.status === 0) console.log(`[engine] ${archiveName()} 已生成`)
  else console.warn('[engine] tar 归档失败（产物目录仍可用）')
}

function archiveName(): string {
  return `notefast-engine-${version}-${platform}.tar.gz`
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

buildWeb()
compile()
copySqliteVec()
copyMacSqlite()
copyWebDist()
writeVersion()
archive()

console.log(`\n✅ engine 产物就绪: ${outDir}/`)
console.log(`   版本: ${version} · 平台: ${platform}`)
