/**
 * 自动导出 → 已迁移到 sync adapter
 *
 * 老 startAutoExport 的行为：
 * - 若 sync manager 已配置且 active adapter 启用，仅打印一条日志告知已被接管
 * - 否则保留一个兜底的 setInterval，循环调用 legacyExportOnce() 写 Markdown
 *
 * 真正的"按 interval 同步"逻辑由 sync/manager.ts 的 autoSyncTimer 负责，
 * 这里仅在环境变量 AUTO_EXPORT_DIR 仍被设置但用户尚未配 sync 时回退。
 *
 * legacyExportMarkdown 同时是 GET /api/v1/sync/export/markdown（api/sync.ts）
 * 的实现——全库一次性兜底导出只保留这一份。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSyncConfigured, syncPush } from '../sync/manager'
import { sanitizeFilename } from '../sync/archive'
import { getDb } from '../db'
import { listDocRows } from '../store/blocks'
import { portableDocMarkdown } from './portableMarkdown'

/** 老入口：保留 API 形态；底层逻辑已切到 sync manager */
export function startAutoExport(dir: string): void {
  if (isSyncConfigured()) {
    console.log(`📁 Auto-export: 已被 sync adapter 接管（dir=${dir} 不再生效）`)
    return
  }
  mkdirSync(dir, { recursive: true })
  console.log(`📁 Auto-export: 启动兜底定时循环 dir=${dir}`)
  // 自重排单循环：10s 后首跑，之后每次跑完再计时 1h。
  // 不用 setTimeout+setInterval 双计时器（首次触发可能紧贴叠加），
  // 也不会因单次导出超过 1h 而与下一圈重叠；timer 无需取消（进程级常驻）
  const tick = async () => {
    await legacyExportOnce(dir)
    setTimeout(() => { void tick() }, 60 * 60 * 1000)
  }
  setTimeout(() => { void tick() }, 10_000)
}

export interface LegacyExportFileResult {
  id: string
  title: string
  file: string
  error?: string
}

export interface LegacyExportResult {
  exported: number
  files: LegacyExportFileResult[]
  dir: string
}

/**
 * AUTO_EXPORT_DIR 兜底导出：全部文档各写一个 `<slug>.md`，返回逐文档结果。
 * 单篇失败不中断，记 error 条目（exported 计数含失败篇，与旧端点语义一致）。
 */
export function legacyExportMarkdown(dir: string): LegacyExportResult {
  const db = getDb()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const docs = listDocRows(db, { order: 'updated_asc' })
  const results: LegacyExportFileResult[] = []
  for (const doc of docs) {
    try {
      const markdown = portableDocMarkdown(doc)
      const slug = sanitizeFilename(doc.content || 'untitled', 120)
      const filename = `${slug}.md`
      writeFileSync(join(dir, filename), markdown, 'utf-8')
      results.push({ id: doc.id, title: doc.content, file: filename })
    } catch (e) {
      results.push({ id: doc.id, title: doc.content, file: '', error: String(e) })
    }
  }
  return { exported: results.length, files: results, dir }
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
    const result = legacyExportMarkdown(dir)
    // 与原实现一致：只统计成功写盘的篇数（失败篇带 error 条目，不计入）
    const count = result.files.filter((f) => !f.error).length
    console.log(`📁 Auto-export (legacy): ${count} docs → ${dir}`)
  } catch (e) {
    console.error('Auto-export failed:', e instanceof Error ? e.message : e)
  }
}
