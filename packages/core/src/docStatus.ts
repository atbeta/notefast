/**
 * 文档生命周期状态（收集箱 vs 正式笔记）
 *
 * 存在 document 根 `blocks.status` 显式列：
 * - 缺省 / `note` → 正式笔记（出现在「所有文档」）
 * - `inbox` → 收集箱（主列表默认排除，待整理）
 */

import { parsePropertiesObject } from './tags'
import type { BlockRow } from './types'

export type DocStatus = 'note' | 'inbox'

/** 从 properties 读状态；非法或缺失一律视为 note（已废弃，使用 readDocStatus） */
export function readDocStatusFromProperties(properties: unknown): DocStatus {
  const obj = parsePropertiesObject(properties)
  return obj.status === 'inbox' ? 'inbox' : 'note'
}

/** 从 BlockRow 显式 status 列读取 */
export function readDocStatus(row: BlockRow): DocStatus {
  return row.status === 'inbox' ? 'inbox' : 'note'
}

/** 从 properties 判收集箱（已废弃，使用 isDocInbox） */
export function isInboxDoc(properties: unknown): boolean {
  return readDocStatusFromProperties(properties) === 'inbox'
}

/** 从 BlockRow 显式列判收集箱 */
export function isDocInbox(row: BlockRow): boolean {
  return row.status === 'inbox'
}

/**
 * 写入 status。note 时删除字段（与默认一致，避免脏 properties）。
 * @deprecated 直接写 blocks.status 列
 */
export function setDocStatusInProperties(properties: unknown, status: DocStatus): string {
  const props = parsePropertiesObject(properties)
  if (status === 'inbox') {
    props.status = 'inbox'
  } else {
    delete props.status
  }
  return JSON.stringify(props)
}

/** 解析 list/MCP 的 status 查询：inbox | note | all；默认 note（排除收集箱） */
export function parseDocStatusFilter(raw: string | null | undefined): 'note' | 'inbox' | 'all' {
  const v = (raw || '').trim().toLowerCase()
  if (v === 'inbox') return 'inbox'
  if (v === 'all') return 'all'
  return 'note'
}
