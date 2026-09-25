/**
 * 自动导出（AUTO_EXPORT_DIR）—— **兜底**，正在被投影取代（RFC 0007 S1）
 *
 * 三层关系，优先级从高到低：
 *   1. 多端同步 adapter 已配置 → `sync/manager` 的 autoSyncTimer 负责，这里直接让位
 *   2. **投影已启用** → 让位给投影。投影就是「把库导出成文件夹」，而且做得更好：
 *      实时（变更即写）、增量（只改被编辑的块，不整篇重写）、路径归用户（D2）。
 *      这时还跑每小时全量重写是纯浪费，也会与投影争同一个目录。
 *   3. 都没有 → 保留兜底定时循环，兼容只设了 AUTO_EXPORT_DIR 的老部署
 *
 * Docker 镜像默认不设该变量，避免每小时全量重写卡住 1 CPU / 512 MB 实例。
 *
 * `legacyExportMarkdown` 同时是 `GET /api/v1/sync/export/markdown`（api/sync.ts）的实现，
 * 是用户主动触发的一次性导出，**不受本收敛影响**——按需调用不是冗余。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readTags } from '@notefast/core'
import { isSyncConfigured, syncPush } from '../sync/manager'
import { getShadowConfig } from './shadowMarkdown'
import { archiveRelPath } from '../sync/archive'
import { getDb } from '../db'
import { listDocRows } from '../store/blocks'
import { portableDocMarkdown } from './portableMarkdown'

/** 投影（影子副本）是否启用——决定这套兜底还要不要跑 */
function isProjectionEnabled(): boolean {
  try {
    return getShadowConfig().enabled
  } catch {
    // 影子副本尚未初始化（早期启动顺序）→ 按未启用处理，走兜底
    return false
  }
}

/** 老入口：保留 API 形态；底层逻辑已切到 sync manager / 投影 */
export function startAutoExport(dir: string): void {
  if (isSyncConfigured()) {
    console.log(`📁 Auto-export: 已被 sync adapter 接管（dir=${dir} 不再生效）`)
    return
  }
  if (isProjectionEnabled()) {
    // 投影是这套兜底的上位替代：更实时、更省、且不与它争目录。
    // 注意这里只是**不启动定时器**，页面上的手动导出仍然可用。
    console.log(
      `📁 Auto-export: 投影已启用，AUTO_EXPORT_DIR（${dir}）不再启动定时导出；` +
        '如需导出请用「设置 → 数据来源」或 GET /api/v1/sync/export/markdown',
    )
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
 * AUTO_EXPORT_DIR 兜底导出：与归档同构，各写 `<tag|untagged>/<slug>--<id>.md`。
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
      const rel = archiveRelPath(doc.content || 'untitled', doc.id, readTags(doc))
      const dest = join(dir, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, markdown, 'utf-8')
      results.push({ id: doc.id, title: doc.content, file: rel })
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
