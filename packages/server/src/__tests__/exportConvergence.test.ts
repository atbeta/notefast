/**
 * 导出路径收敛（RFC 0007 S1/S2）。
 *
 * 三条「导出 Markdown」路径里，只有 `AUTO_EXPORT_DIR` 的**定时器**是冗余的：
 * 投影已启用时它就是「把库导出成文件夹」的劣化版本（整篇重写、每小时一次、
 * 且与投影争同一个目录）。手动导出端点不受影响——按需调用不是冗余。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { closeDb, getDb, initDb } from '../db'
import { insertDocFromMarkdown } from '../services/docImport'
import { legacyExportMarkdown, startAutoExport } from '../services/autoExport'
import { applyShadowConfig, initShadowMarkdown } from '../services/shadowMarkdown'
import { archiveFilename, archiveRelPath } from '../sync/archive'

let testDir: string
let notebookId: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-converge-'))
  notebookId = initDb(testDir).notebookId
  initShadowMarkdown(testDir)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

afterEach(() => {
  // 影子副本配置是模块级状态，用例之间必须还原
  applyShadowConfig({ enabled: true, pathMode: 'system' })
})

describe('S2：归档命名只服务一次性输出', () => {
  test('archiveRelPath 形态：<首标签>/<slug>--<id12>.md', () => {
    const rel = archiveRelPath('我的笔记', 'abcdef12-3456-7890-abcd-ef1234567890', ['work'])
    expect(rel).toBe('work/我的笔记--abcdef123456.md')
  })

  test('无标签落 untagged，且 id 后缀保证同名不覆盖', () => {
    const a = archiveRelPath('同名', 'aaaaaaaa-0000-0000-0000-000000000000', [])
    const b = archiveRelPath('同名', 'bbbbbbbb-0000-0000-0000-000000000000', [])
    expect(a.startsWith('untagged/')).toBe(true)
    expect(a).not.toBe(b)
    expect(archiveFilename('同名', 'aaaaaaaa-0000-0000-0000-000000000000')).toBe('同名--aaaaaaaa0000.md')
  })
})

describe('S1：投影启用时不再启动兜底定时导出', () => {
  test('投影启用 → startAutoExport 不创建目录、不写文件', () => {
    applyShadowConfig({ enabled: true })
    const target = join(testDir, 'auto-export-enabled')
    insertDocFromMarkdown(getDb(), { notebookId, title: '定时导出', markdown: '内容\n' })

    startAutoExport(target)
    // 未启动定时器 → 目录不该被建出来
    expect(existsSync(target)).toBe(false)
  })

  test('投影关闭 → 保留兜底行为（建目录）', () => {
    applyShadowConfig({ enabled: false })
    const target = join(testDir, 'auto-export-disabled')
    startAutoExport(target)
    // 兜底路径会 mkdir
    expect(existsSync(target)).toBe(true)
  })

  test('手动导出端点不受收敛影响（按需调用不是冗余）', () => {
    applyShadowConfig({ enabled: true })
    const target = join(testDir, 'manual-export')
    insertDocFromMarkdown(getDb(), { notebookId, title: '手动导出', markdown: '正文\n' })

    const result = legacyExportMarkdown(target)
    expect(result.exported).toBeGreaterThanOrEqual(1)
    expect(existsSync(target)).toBe(true)
    // 文件名沿用归档形态（id 后缀）
    const all = readdirSync(target, { recursive: true }) as string[]
    expect(all.some((f) => String(f).endsWith('.md'))).toBe(true)
  })

  test('手动导出的内容与投影内容一致（同一份 portableDocMarkdown）', () => {
    const { docId } = insertDocFromMarkdown(getDb(), {
      notebookId,
      title: '内容一致',
      markdown: '一段正文\n\n另一段\n',
    })
    const target = join(testDir, 'manual-content')
    const result = legacyExportMarkdown(target)
    const entry = result.files.find((f) => f.id === docId)
    expect(entry).toBeTruthy()
    expect(entry!.error).toBeUndefined()
    const written = readFileSync(join(target, entry!.file), 'utf-8')
    expect(written).toContain('一段正文')
    expect(written).toContain('另一段')
  })
})

describe('S1：sync adapter 优先级高于投影', () => {
  test('未配置 sync 且投影启用 → 都不跑定时导出', () => {
    applyShadowConfig({ enabled: true })
    const target = join(testDir, 'both-off')
    startAutoExport(target)
    expect(existsSync(target)).toBe(false)
  })
})
