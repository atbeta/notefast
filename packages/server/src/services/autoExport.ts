/**
 * 自动导出 → 已迁移到 sync adapter
 *
 * 老 startAutoExport 的行为：
 * - 若 sync manager 已配置且 active adapter 启用，仅打印一条日志告知已被接管
 * - 否则保留一个兜底的 setInterval，循环调用 legacyExportOnce() 写 Markdown
 *
 * 真正的"按 interval 同步"逻辑由 sync/manager.ts 的 autoSyncTimer 负责，
 * 这里仅在环境变量 AUTO_EXPORT_DIR 仍被设置但用户尚未配 sync 时回退。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  blocksToMarkdown,
  buildBlockTree,
  type BlockRow,
} from '@notefast/core'
import { isSyncConfigured, syncPush } from '../sync/manager'
import { getDb } from '../db'
import { fetchDocBlocks } from '../dbQueries'

/** 老入口：保留 API 形态；底层逻辑已切到 sync manager */
export function startAutoExport(dir: string): void {
  if (isSyncConfigured()) {
    console.log(`📁 Auto-export: 已被 sync adapter 接管（dir=${dir} 不再生效）`)
    return
  }
  mkdirSync(dir, { recursive: true })
  console.log(`📁 Auto-export: 启动兜底定时循环 dir=${dir}`)
  setTimeout(() => { legacyExportOnce(dir) }, 10_000)
  setInterval(() => { legacyExportOnce(dir) }, 60 * 60 * 1000)
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'untitled'
}

/** 兜底循环：如果 sync adapter 没配，跑原导出逻辑 */
async function legacyExportOnce(dir: string): Promise<void> {
  if (isSyncConfigured()) {
    try {
      const r = await syncPush()
      console.log(`📁 Auto-export: ${r.pushed} docs via adapter`)
    } catch (e) {
      console.warn('📁 Auto-export: adapter push failed', e instanceof Error ? e.message : e)
    }
    return
  }
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const db = getDb()
    const docs = db.query("SELECT * FROM blocks WHERE type = 'document' ORDER BY updated_at ASC").all() as BlockRow[]
    let count = 0
    for (const doc of docs) {
      try {
        const tree = buildBlockTree(fetchDocBlocks(db, doc.id))
        const markdown = blocksToMarkdown(tree)
        const slug = sanitizeFilename(doc.content || 'untitled')
        writeFileSync(join(dir, `${slug}.md`), markdown, 'utf-8')
        count++
      } catch { /* skip */ }
    }
    console.log(`📁 Auto-export (legacy): ${count} docs → ${dir}`)
  } catch (e) {
    console.error('Auto-export failed:', e instanceof Error ? e.message : e)
  }
}
