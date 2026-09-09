#!/usr/bin/env bun
/**
 * vault mode PoC — 独立 chokidar 监听器
 *
 * 用途：验证 "vault 文件变更 → SQLite 索引更新" 的最小闭环
 *
 * 运行：
 *   # 1. 启动 NoteFast server（或 NoteFast Next server）
 *   bun --filter @notefast-next/server dev
 *
 *   # 2. 在另一个终端跑这个 PoC
 *   VAULT_PATH=./test-vault \
 *   NF_URL=http://localhost:3140 \
 *   NF_TOKEN=<your-token> \
 *   bun run tools/vault-poc/chokidar-demo.ts
 *
 *   # 3. 编辑 test-vault/ 下的任意 .md 文件，观察输出
 *
 * 设计：
 *   - 不依赖 vault 骨架代码，独立 200 行
 *   - 直接调 main 已有的 /api/v1/import/markdown 端点
 *   - 用 source = { provider: "vault-watcher", external_id: <rel-path> } 做去重
 *   - block ID 稳定性由 main v0.86 的 blockAlign 在 save 路径上保证
 *
 * 这是 RFC 0001 的验证工具，不是产品代码。
 */

import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import chokidar from 'chokidar'

const VAULT_PATH = process.env.VAULT_PATH ?? './test-vault'
const NF_URL = process.env.NF_URL ?? 'http://localhost:3140'
const NF_TOKEN = process.env.NF_TOKEN ?? ''

if (!NF_TOKEN) {
  console.error('NF_TOKEN is required. Set NF_TOKEN env var.')
  process.exit(1)
}

const vaultPath = resolve(VAULT_PATH)
console.log(`[vault-poc] watching ${vaultPath}`)
console.log(`[vault-poc] pushing to ${NF_URL}/api/v1/import/markdown`)

interface IngestResult {
  status: number
  dedup: boolean
  docId?: string
}

async function ingestFile(filePath: string): Promise<IngestResult> {
  const content = await readFile(filePath, 'utf8')
  const relPath = relative(vaultPath, filePath)
  const title = relPath.replace(/\.md$/i, '').replace(/\//g, ' / ')

  const res = await fetch(`${NF_URL}/api/v1/import/markdown`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      markdown: content,
      title,
      status: 'note',
      source: {
        provider: 'vault-watcher',
        external_id: relPath,
      },
    }),
  })

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return {
    status: res.status,
    dedup: body['deduplicated'] === true,
    docId: body['doc']?.['id'] as string | undefined,
  }
}

const queue: Array<{ kind: 'change' | 'delete'; path: string }> = []
let running = false

async function drain() {
  running = true
  while (queue.length > 0) {
    const job = queue.shift()!
    const start = Date.now()
    try {
      if (job.kind === 'change') {
        const result = await ingestFile(job.path)
        const tag = result.dedup ? '[dedup]' : '[new]   '
        console.log(
          `${tag} ${job.path} → ${result.status} (${Date.now() - start}ms)` +
            (result.docId ? ` doc=${result.docId}` : ''),
        )
      } else {
        console.log(`[delete] ${job.path} (PoC: not actually deleting from server)`)
        // TODO: 实现 doc 标记 stale + 30 天保留
      }
    } catch (err) {
      console.error(`[error]  ${job.path}:`, err)
    }
  }
  running = false
}

function enqueue(kind: 'change' | 'delete', path: string) {
  queue.push({ kind, path })
  if (!running) void drain()
}

const watcher = chokidar.watch(`${vaultPath}/**/*.md`, {
  ignored: /(^|[/\\])(\..*|node_modules)/,
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
})

watcher.on('add', (p: string) => enqueue('change', p))
watcher.on('change', (p: string) => enqueue('change', p))
watcher.on('unlink', (p: string) => enqueue('delete', p))
watcher.on('ready', () => {
  console.log('[vault-poc] ready, watching for changes...')
  console.log('[vault-poc] try: echo "# hello" > test-vault/test.md')
})

const shutdown = async () => {
  console.log('\n[vault-poc] shutting down...')
  await watcher.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
