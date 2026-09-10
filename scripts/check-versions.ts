/**
 * 版本一致性校验（CI 门禁）
 *
 * 起因：release-please 通过 extra-files 改各处的版本号，但历史上漏过
 * `clients/tauri/src-tauri/Cargo.lock`（它不在默认版本文件里），于是每次发版后
 * 都要人工补一个 `chore(tauri): sync Cargo.lock` 提交。现在 Cargo.lock 已在
 * `.github/release-please-config.json` 的 extra-files 里，这个脚本负责**一旦再漏就当场失败**，
 * 而不是等到发版之后才发现（`--locked` 构建会在干净 clone 上直接报错）。
 *
 * 只做只读校验，不改文件：
 *   bun run packages/../scripts?（位置见下）—— 实际入口：`bun run check:versions`
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, rel), 'utf-8')) as Record<string, unknown>
}

/** 从 Cargo.toml / Cargo.lock 里取 `name = "notefast-tauri"` 那一块的 version */
function cargoVersion(rel: string, opts: { lock: boolean }): string | null {
  const text = readFileSync(join(root, rel), 'utf-8')
  if (!opts.lock) {
    const m = text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)
    return m?.[1] ?? null
  }
  for (const block of text.split('[[package]]').slice(1)) {
    if (!block.includes('name = "notefast-tauri"')) continue
    return block.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null
  }
  return null
}

const expected = readJson('package.json').version as string
const checks: Array<{ label: string; actual: string | null }> = [
  { label: 'package.json', actual: expected },
  { label: 'packages/core/package.json', actual: readJson('packages/core/package.json').version as string },
  { label: 'packages/server/package.json', actual: readJson('packages/server/package.json').version as string },
  { label: 'packages/web/package.json', actual: readJson('packages/web/package.json').version as string },
  { label: 'clients/tauri/package.json', actual: readJson('clients/tauri/package.json').version as string },
  { label: 'clients/tauri/src-tauri/tauri.conf.json', actual: readJson('clients/tauri/src-tauri/tauri.conf.json').version as string },
  { label: 'clients/tauri/src-tauri/Cargo.toml', actual: cargoVersion('clients/tauri/src-tauri/Cargo.toml', { lock: false }) },
  { label: 'clients/tauri/src-tauri/Cargo.lock', actual: cargoVersion('clients/tauri/src-tauri/Cargo.lock', { lock: true }) },
]

const mismatched = checks.filter((c) => c.actual !== expected)
for (const c of checks) {
  const mark = c.actual === expected ? '✓' : '✗'
  console.log(`${mark} ${c.label}: ${c.actual ?? '(未找到)'}`)
}
if (mismatched.length > 0) {
  console.error(
    `\n版本不一致：根 package.json 是 ${expected}，但上面标 ✗ 的文件不是。\n` +
      'release-please 应该一并改掉它们（见 .github/release-please-config.json 的 extra-files）；\n' +
      '漏改时手工同步对应文件即可，但请同时确认 extra-files 配置没被改坏。',
  )
  process.exit(1)
}
console.log(`\n版本一致：${expected}`)
