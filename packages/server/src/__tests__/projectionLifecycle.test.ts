/**
 * 端到端验收：把一个投影文件夹当成真实用户文件夹来对待。
 * 这条用例回答「整个方案到底成没成」。
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { closeDb, getDb, initDb } from '../db'
import { fetchDocBlocks, getDocById, getLiveDocById } from '../store/blocks'
import { initAssetStore, saveAsset } from '../assets/store'
import { createSerialLock } from '../projection/lock'
import { ingestProjectionFile, removeProjectionFile, type ProjectionContext } from '../projection/ingest'
import { renderProjectionContent, writeProjectionDoc } from '../projection/writeback'
import { getProjectionFileByPath } from '../store/projectionFiles'
import { resolveProjectionConfig } from '../projection/config'

let dir: string, root: string, ctx: ProjectionContext
beforeAll(() => {
  dir = mkdtempSync(join('/tmp','nf-e2e-'))
  const { notebookId } = initDb(dir)
  initAssetStore(dir)
  root = join(dir,'notes'); mkdirSync(root,{recursive:true})
  ctx = { db: getDb(), notebookId, config: resolveProjectionConfig(root,{}), lock: createSerialLock() }
})
afterAll(() => { closeDb(); rmSync(dir,{recursive:true,force:true}) })

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,9,9,9])

describe('端到端', () => {
  test('完整生命周期：导入 → 库改 → 外部改 → 冲突 → 删除 → 恢复', async () => {
    // 1. 用户在文件夹里放一篇带图的笔记
    const { meta } = saveAsset(PNG, 'image/png')
    const original = `# 我的笔记\n\n第一段\n\n![图](asset:${meta.id})\n\n第三段\n`
    writeFileSync(join(root,'我的笔记.md'), original, 'utf-8')
    const r1 = await ingestProjectionFile(ctx, '我的笔记.md')
    expect(r1.action).toBe('created')
    const docId = r1.docId!

    // 2. 库侧改一个块 → 文件只动那一块，图片引用落资源夹
    getDb().query("UPDATE blocks SET content='第三段（改）' WHERE root_id=? AND content='第三段'").run(docId)
    let doc = getDocById(getDb(), docId)!
    let rendered = renderProjectionContent(getDb(), doc, readFileSync(join(root,'我的笔记.md'),'utf-8'), {
      relPath: '我的笔记.md',
      config: ctx.config,
    })
    expect(rendered.mode).toBe('patch')
    await writeProjectionDoc(ctx, { doc, relPath: '我的笔记.md', content: rendered.content })

    let disk = readFileSync(join(root,'我的笔记.md'),'utf-8')
    expect(disk).toContain('第三段（改）')
    expect(disk).toContain('我的笔记.assets/')
    expect(disk).not.toContain('asset:')
    // 图片真的在文件夹里
    const ref = disk.match(/([^\s()]+\.assets)\/[0-9a-f]{16}\.png/)![1]!
    expect(existsSync(join(dirname(join(root,'我的笔记.md')), ref))).toBe(true)

    // 3. 文件夹自包含：正文里的每个相对图片引用都在文件夹内存在
    for (const m of disk.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      expect(m[1]!.startsWith('/')).toBe(false)
      expect(existsSync(join(dirname(join(root,'我的笔记.md')), m[1]!))).toBe(true)
    }

    // 4. 用户在外部改文件 → 导入跟上
    writeFileSync(join(root,'我的笔记.md'), disk.replace('第一段','第一段（外部改）'), 'utf-8')
    const r2 = await ingestProjectionFile(ctx, '我的笔记.md')
    expect(r2.action).toBe('updated')
    expect(fetchDocBlocks(getDb(), docId).some(b=>b.content==='第一段（外部改）')).toBe(true)

    // 5. 两边同时改 → 冲突副本，且库赢
    const mapping = getProjectionFileByPath(getDb(), ctx.notebookId, '我的笔记.md')!
    writeFileSync(join(root,'我的笔记.md'), '外部抢先改的内容\n', 'utf-8')
    doc = getDocById(getDb(), docId)!
    const conflict = await writeProjectionDoc(ctx, {
      doc, relPath:'我的笔记.md', expectedSha: mapping.content_sha256, content:'库版本内容\n',
    })
    expect(conflict.kind).toBe('conflict')
    expect(readFileSync(join(root,'我的笔记.md'),'utf-8')).toContain('库版本内容')

    // 6. 删除文件 → 进回收站（内容还在）
    unlinkSync(join(root,'我的笔记.md'))
    expect(removeProjectionFile(ctx,'我的笔记.md').action).toBe('deleted')
    expect(getLiveDocById(getDb(), docId)).toBeNull()
    expect(fetchDocBlocks(getDb(), docId).length).toBeGreaterThan(1)

    // 7. 文件回来 → 认领同一篇文档，不新建
    writeFileSync(join(root,'我的笔记.md'), '库版本内容\n', 'utf-8')
    const r3 = await ingestProjectionFile(ctx, '我的笔记.md')
    expect(r3.docId).toBe(docId)
    expect(getLiveDocById(getDb(), docId)).not.toBeNull()
  })
})
