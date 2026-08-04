/**
 * 打包前准备：把 engine 产物复制到 src-tauri/resources/engine
 * （tauri.conf.json 的 bundle.resources 引用；该目录已 gitignore）
 *
 * 用法：bun run prepare:engine（package.json 脚本）
 * 前置：bun run build:engine 已产出 packages/server/dist-engine
 */

import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..', '..')
const engineSrc = join(root, 'packages', 'server', 'dist-engine')
const engineDest = join(import.meta.dir, '..', 'src-tauri', 'resources', 'engine')

const binary = process.platform === 'win32' ? 'notefast-server.exe' : 'notefast-server'
if (!existsSync(join(engineSrc, binary))) {
  console.error(`[prepare] dist-engine 缺失（${engineSrc}），请先 bun run build:engine`)
  process.exit(1)
}

rmSync(engineDest, { recursive: true, force: true })
cpSync(engineSrc, engineDest, { recursive: true })
console.log(`[prepare] engine → ${engineDest}`)
