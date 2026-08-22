/**
 * 实体词典（term-dict）测试
 *
 * 覆盖：
 * - 空词典（无文件）：resolve/expand 返回 null，检索行为零变化
 * - 加载与规范化（无效条目跳过、别名去重、kind 白名单）
 * - 保存校验（标准名过短 / 重复 / 别名与标准名相同 → 抛错）
 * - 抽取端归并：registerMentions 别名锚点 → 标准名实体（display=标准名、kind 覆盖）
 * - 查询端展开：lexicalSearch 查「wafer」命中含「晶圆」的块（组内 OR 不变宽）
 * - 实体路反向：entitySearch 查「tape-out」精确命中标准实体「流片」
 * - 存量归并 rebuild：别名实体合并进标准实体（mention_count 收敛、旧名登记别名、幂等）
 * - REST 契约：GET / PUT / POST /rebuild
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb, getDb } from '../db'
import {
  initTermDict,
  resetTermDictForTests,
  dictFilePath,
  resolveDictTerm,
  expandDictTerm,
  saveTermDictToDisk,
  rebuildDictEntities,
  getTermDict,
} from '../termDict'
import { registerMentions } from '../ai/entities'
import { lexicalSearch } from '../lexicalSearch'
import { entitySearch } from '../ai/entitySearch'
import { deleteMentionsFromSource, findEntityByName, listEntities } from '../store/entities'
import termDictRouter from '../api/termDict'
import entitiesRouter from '../api/entities'

let testDir: string
let nb: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-termdict-'))
  initDb(testDir)
  initTermDict(testDir)
  nb = crypto.randomUUID()
  getDb().query('INSERT INTO notebooks (id, name) VALUES (?, ?)').run(nb, 'T')
})

afterAll(() => {
  resetTermDictForTests()
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  // 每次用例清空词典文件 + 实体表 + blocks，保证隔离
  const path = dictFilePath()
  if (path && existsSync(path)) {
    rmSync(path)
  }
  resetTermDictForTests()
  initTermDict(testDir)
  const db = getDb()
  db.query('DELETE FROM blocks').run()
  db.query('DELETE FROM entities').run()
  db.query('DELETE FROM entity_mentions').run()
})

/** 种一个 block（document 根 + paragraph 正文），返回正文块 id */
function seedBlock(content: string, title = 'Untitled'): string {
  const db = getDb()
  const id = crypto.randomUUID()
  const docId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
  ).run(docId, nb, docId, title, now, now)
  db.query(
    `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'paragraph', ?, 0, 1, ?, ?)`,
  ).run(id, nb, docId, docId, content, now, now)
  return id
}

function writeDict(terms: unknown[]) {
  writeFileSync(dictFilePath()!, JSON.stringify({ version: 1, terms }))
  resetTermDictForTests()
  initTermDict(testDir)
}

describe('空词典（无文件）', () => {
  test('resolve / expand 全部 null，统计为零', () => {
    expect(resolveDictTerm('wafer')).toBeNull()
    expect(expandDictTerm('wafer')).toBeNull()
    const d = getTermDict()
    expect(d.entries.length).toBe(0)
  })
})

describe('加载与规范化', () => {
  test('正常条目 + 无效条目跳过', () => {
    writeDict([
      { name: '晶圆', aliases: ['wafer', 'Wafer', '晶圆片'] },
      { name: '流片', aliases: ['tape-out'], kind: 'concept' },
      { name: 'x' }, // 标准名 <2 字 → 跳过
      { name: '重复', aliases: ['重复'] }, // 别名与标准名相同 → 跳过别名
      { name: '坏kind', aliases: ['bad'], kind: 'whatever' }, // kind 白名单外 → 忽略
    ])
    const d = getTermDict()
    expect(d.entries.length).toBe(4) // 'x' 跳过；'坏kind' 名称合法仅 kind 忽略
    expect(d.entries[0]!.aliases).toEqual(['wafer', '晶圆片']) // Wafer 按 normalized 去重
    expect(d.entries[1]!.kind).toBe('concept')
    expect(d.entries[2]!.aliases).toEqual([])
    expect(d.entries[3]!.kind).toBeUndefined()
  })

  test('解析失败的文件 → 空词典 + 不抛错', () => {
    writeFileSync(dictFilePath()!, '{ 不是合法 JSON')
    resetTermDictForTests()
    initTermDict(testDir)
    expect(getTermDict().entries.length).toBe(0)
  })
})

describe('resolve / expand', () => {
  beforeEach(() => {
    writeDict([
      { name: '晶圆', aliases: ['wafer', '晶圆片'] },
      { name: '流片', aliases: ['tape-out', '送片'] },
    ])
  })

  test('别名 → 标准名（含 display 与 kind）', () => {
    expect(resolveDictTerm('wafer')).toEqual({ name: '晶圆', display: '晶圆', kind: undefined })
    expect(resolveDictTerm('TAPE-OUT')).toEqual({ name: '流片', display: '流片', kind: undefined })
    expect(resolveDictTerm('晶圆')).toEqual({ name: '晶圆', display: '晶圆', kind: undefined }) // 标准名自身
    expect(resolveDictTerm('无关词')).toBeNull()
  })

  test('expand 返回 [原 term, 标准名, ...别名] 去重', () => {
    expect(expandDictTerm('wafer')).toEqual(['wafer', '晶圆', '晶圆片'])
    expect(expandDictTerm('晶圆')).toEqual(['晶圆', 'wafer', '晶圆片'])
    expect(expandDictTerm('tape-out')).toEqual(['tape-out', '流片', '送片'])
    expect(expandDictTerm('无关')).toBeNull()
  })

  test('匹配键全半角归一：全角别名与半角查询互相命中', () => {
    writeDict([
      { name: '晶圆', aliases: ['wafer', '（晶圆片）'] }, // 全角括号别名
      { name: '流片', aliases: ['tape-out', 'TAPE-OUT'] }, // 大小写别名
    ])
    expect(resolveDictTerm('(晶圆片)')).toEqual({ name: '晶圆', display: '晶圆', kind: undefined })
    expect(resolveDictTerm('tape-out')).toEqual({ name: '流片', display: '流片', kind: undefined })
    expect(expandDictTerm('（晶圆片）')).toEqual(['（晶圆片）', '晶圆', 'wafer'])
  })

  test('description：加载保留、resolve 返回、空白剔除', () => {
    writeDict([
      { name: '晶圆', aliases: ['wafer'], description: '半导体制造的基底材料' },
      { name: '流片', aliases: ['tape-out'] },
      { name: '空描述', aliases: [], description: '   ' },
    ])
    // 标准名与别名都能带出 description
    expect(resolveDictTerm('wafer')).toEqual({
      name: '晶圆',
      display: '晶圆',
      kind: undefined,
      description: '半导体制造的基底材料',
    })
    expect(resolveDictTerm('晶圆')).toEqual({
      name: '晶圆',
      display: '晶圆',
      kind: undefined,
      description: '半导体制造的基底材料',
    })
    // 无描述条目不带 description；空白描述被剔除
    expect(resolveDictTerm('tape-out')).toEqual({ name: '流片', display: '流片', kind: undefined })
    expect(getTermDict().entries.find((e) => e.name === '空描述')?.description).toBeUndefined()
  })
})

describe('保存校验', () => {
  test('标准名过短 / 重复 / 别名等于标准名 → 抛错', () => {
    expect(() => saveTermDictToDisk([{ name: 'a', aliases: [] }])).toThrow(/过短/)
    expect(() =>
      saveTermDictToDisk([
        { name: '晶圆', aliases: [] },
        { name: ' 晶圆 ', aliases: [] }, // normalized 重复
      ]),
    ).toThrow(/重复/)
    expect(() => saveTermDictToDisk([{ name: '晶圆', aliases: ['晶圆'] }])).toThrow(/相同/)
  })
})

describe('抽取端归并（registerMentions）', () => {
  test('别名锚点 → 标准名实体，display 用标准名', () => {
    writeDict([{ name: '晶圆', aliases: ['wafer'] }])
    const blockId = seedBlock('晶圆良率控制')
    const registered = registerMentions(blockId, [
      { anchor: 'wafer', kind: 'tool' },
      { anchor: '晶圆片', kind: 'concept' },
    ])
    expect(registered).toBe(2)
    const entity = findEntityByName(getDb(), '晶圆')
    expect(entity).not.toBeNull()
    expect(entity!.display).toBe('晶圆')
    expect(entity!.kind).toBe('tool') // 首个锚点的 kind（tool）在标准名创建时生效
  })

  test('kind 覆盖：词典指定 kind 时优先', () => {
    writeDict([{ name: '流片', aliases: ['tape-out'], kind: 'concept' }])
    const blockId = seedBlock('流片流程')
    registerMentions(blockId, [{ anchor: 'tape-out', kind: 'tool' }])
    const entity = findEntityByName(getDb(), '流片')
    expect(entity!.kind).toBe('concept')
  })
})

describe('查询端展开（lexicalSearch）', () => {
  test('查别名「wafer」命中含标准名「晶圆」的块', () => {
    writeDict([{ name: '晶圆', aliases: ['wafer', '晶圆片'] }])
    const target = seedBlock('晶圆良率控制方法')
    seedBlock('完全无关的内容')

    const hits = lexicalSearch('wafer', { limit: 10 })
    expect(hits.some((h) => h.id === target)).toBe(true)
  })

  test('组间 AND 语义不变宽：多 term 查询每组都要有命中', () => {
    writeDict([{ name: '晶圆', aliases: ['wafer'] }])
    const target = seedBlock('晶圆 良率 控制')
    seedBlock('良率 提升')

    // 「wafer 良率」→ (wafer|晶圆) AND 良率
    const hits = lexicalSearch('wafer 良率', { limit: 10 })
    expect(hits.some((h) => h.id === target)).toBe(true)
    // strictOnly 下无 OR 降级：只有晶圆、没有光刻 → 不命中（展开不变宽组间语义）
    const misses = lexicalSearch('wafer 光刻', { limit: 10, strictOnly: true })
    expect(misses.some((h) => h.id === target)).toBe(false)
  })

  test('标题通道同样展开', () => {
    writeDict([{ name: '晶圆', aliases: ['wafer'] }])
    const db = getDb()
    const docId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.query(
      `INSERT INTO blocks (id, notebook_id, parent_id, root_id, type, content, sort, level, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'document', ?, 0, 0, ?, ?)`,
    ).run(docId, nb, docId, '晶圆制造手册', now, now)
    const hits = lexicalSearch('wafer 手册', { limit: 10, strictOnly: true, titleOnly: true })
    expect(hits.some((h) => h.root_id === docId)).toBe(true)
  })
})

describe('实体路反向（entitySearch）', () => {
  test('查别名精确命中标准实体', () => {
    writeDict([{ name: '流片', aliases: ['tape-out', '送片'] }])
    const blockId = seedBlock('流片流程梳理')
    registerMentions(blockId, [{ anchor: '流片', kind: 'concept' }])

    const hits = entitySearch('tape-out')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.block_id).toBe(blockId)
  })

  test('未命中词典的词保持原语义', () => {
    const blockId = seedBlock('随便提一个实体')
    registerMentions(blockId, [{ anchor: '随便提一个实体', kind: 'concept' }])
    const hits = entitySearch('随便提一个实体')
    expect(hits.length).toBeGreaterThan(0)
  })
})

describe('存量归并（rebuildDictEntities）', () => {
  test('别名实体合并进标准实体：mention 收敛、旧名登记别名、幂等', () => {
    // 无词典时先抽成两个分裂实体
    const waferBlock = seedBlock('wafer 参数讨论')
    const liangBlock = seedBlock('晶圆良率讨论')
    registerMentions(waferBlock, [{ anchor: 'wafer', kind: 'concept' }])
    registerMentions(liangBlock, [{ anchor: '晶圆', kind: 'concept' }])
    const before = listEntities(getDb())
    expect(before.length).toBe(2)

    // 声明词典 + 归并
    writeDict([{ name: '晶圆', aliases: ['wafer'] }])
    const result = rebuildDictEntities()
    expect(result.merged).toBe(1)
    expect(result.created).toBe(0)

    const after = listEntities(getDb())
    expect(after.length).toBe(1)
    const standard = findEntityByName(getDb(), '晶圆')!
    expect(standard.mention_count).toBe(2)

    // 旧名登记为别名（mergeEntities 行为），后续抽取直接路由
    const alias = getDb()
      .query('SELECT entity_id FROM entity_aliases WHERE alias = ?')
      .get('wafer') as { entity_id: string } | undefined
    expect(alias?.entity_id).toBe(standard.id)

    // 幂等：再跑一次无变化
    const again = rebuildDictEntities()
    expect(again.merged).toBe(0)
  })

  test('kind 覆盖：rebuild 更新存量实体 kind', () => {
    const blockId = seedBlock('晶圆相关')
    registerMentions(blockId, [{ anchor: '晶圆', kind: 'tool' }])
    writeDict([{ name: '晶圆', aliases: [], kind: 'concept' }])
    const result = rebuildDictEntities()
    expect(result.kindUpdated).toBe(1)
    expect(findEntityByName(getDb(), '晶圆')!.kind).toBe('concept')
  })
})

describe('有效描述合并（词典 > AI 生成）', () => {
  test('GET /entities：词典描述优先，description_source 标注来源', async () => {
    writeDict([
      { name: '晶圆', aliases: ['wafer'], description: '词典描述：半导体基底材料' },
      { name: '流片', aliases: ['tape-out'] }, // 词典无描述
    ])
    const db = getDb()
    const now = new Date().toISOString()
    const mk = (name: string, aiDesc: string | null) =>
      db
        .query(
          `INSERT INTO entities (id, name, display, kind, mention_count, description, created_at, updated_at)
           VALUES (?, ?, ?, 'concept', 3, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), name, name, aiDesc, now, now)
    mk('晶圆', 'AI 描述：旧值') // 词典 + AI 都有 → 词典赢
    mk('流片', 'AI 描述：流片相关') // 仅 AI
    mk('rag', 'AI 描述：RAG 相关') // 不在词典

    const res = await entitiesRouter.request('/')
    const body = (await res.json()) as {
      entities: Array<{ name: string; description: string | null; description_source: string | null }>
    }
    const byName = new Map(body.entities.map((e) => [e.name, e]))
    expect(byName.get('晶圆')?.description).toBe('词典描述：半导体基底材料')
    expect(byName.get('晶圆')?.description_source).toBe('dict')
    expect(byName.get('流片')?.description).toBe('AI 描述：流片相关')
    expect(byName.get('流片')?.description_source).toBe('ai')
    expect(byName.get('rag')?.description).toBe('AI 描述：RAG 相关')
    expect(byName.get('rag')?.description_source).toBe('ai')
  })
})

describe('REST 契约', () => {
  test('GET 空词典 / PUT 保存 / 自动归并 / POST rebuild', async () => {
    const getRes = await termDictRouter.request('/')
    expect(getRes.status).toBe(200)
    const emptyBody = (await getRes.json()) as { enabled: boolean; count: number }
    expect(emptyBody.enabled).toBe(false)
    expect(emptyBody.count).toBe(0)

    // PUT 非法结构 → 400
    const badRes = await termDictRouter.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terms: [{ name: '' }] }),
    })
    expect(badRes.status).toBe(400)

    // 先种分裂实体，PUT 后自动归并
    const waferBlock = seedBlock('wafer 自动归并')
    registerMentions(waferBlock, [{ anchor: 'wafer', kind: 'concept' }])

    const putRes = await termDictRouter.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terms: [{ name: '晶圆', aliases: ['wafer'] }] }),
    })
    expect(putRes.status).toBe(200)
    const putBody = (await putRes.json()) as { count: number; terms: Array<{ name: string; aliases: string[] }> }
    expect(putBody.count).toBe(1)
    // 自动归并已把 wafer 合并进晶圆
    expect(listEntities(getDb()).length).toBe(1)
    expect(findEntityByName(getDb(), '晶圆')!.mention_count).toBe(1)

    const rebuildRes = await termDictRouter.request('/rebuild', { method: 'POST' })
    expect(rebuildRes.status).toBe(200)
    const rebuildBody = (await rebuildRes.json()) as { merged: number }
    expect(rebuildBody.merged).toBe(0) // 幂等

    const getRes2 = await termDictRouter.request('/')
    const body2 = (await getRes2.json()) as { terms: Array<{ name: string; aliases: string[] }> }
    expect(body2.terms).toEqual([{ name: '晶圆', aliases: ['wafer'] }])
    // PUT 回写条目，UI 才能用服务端规范化结果刷新，不必再 GET
    expect((putBody as { terms?: unknown }).terms).toEqual([{ name: '晶圆', aliases: ['wafer'] }])
  })

  test('实体页 / MCP 按词典别名能搜到标准实体（含 0 提及）', async () => {
    writeDict([{ name: '晶圆', aliases: ['wafer', '晶圆片'] }])
    const result = rebuildDictEntities()
    expect(result.created).toBe(1)
    expect(findEntityByName(getDb(), '晶圆')!.mention_count).toBe(0)

    // store：别名 / 标准名都能列出
    expect(listEntities(getDb(), { q: 'wafer' }).map((e) => e.name)).toEqual(['晶圆'])
    expect(listEntities(getDb(), { q: '晶圆片' }).map((e) => e.name)).toEqual(['晶圆'])
    expect(listEntities(getDb(), { q: '晶圆' }).map((e) => e.name)).toEqual(['晶圆'])

    const res = await entitiesRouter.request('/?q=wafer')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entities: Array<{ name: string }> }
    expect(body.entities.map((e) => e.name)).toEqual(['晶圆'])
  })

  test('无关提及归零清扫不误删词典新建的 0 提及实体', () => {
    writeDict([{ name: '晶圆', aliases: ['wafer'] }])
    rebuildDictEntities()
    expect(findEntityByName(getDb(), '晶圆')).not.toBeNull()

    const other = seedBlock('无关提及')
    registerMentions(other, [{ anchor: '无关提及', kind: 'concept' }])
    expect(findEntityByName(getDb(), '无关提及')).not.toBeNull()
    deleteMentionsFromSource(getDb(), other)

    expect(findEntityByName(getDb(), '无关提及')).toBeNull()
    expect(findEntityByName(getDb(), '晶圆')).not.toBeNull()
    expect(findEntityByName(getDb(), '晶圆')!.mention_count).toBe(0)
  })

  test('PUT 后词典立即生效（缓存失效）', async () => {
    const putRes = await termDictRouter.request('/', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terms: [{ name: '版图', aliases: ['layout'] }] }),
    })
    expect(putRes.status).toBe(200)
    expect(resolveDictTerm('layout')).toEqual({ name: '版图', display: '版图', kind: undefined })
    const blockId = seedBlock('版图设计要点')
    const hits = lexicalSearch('layout', { limit: 10 })
    expect(hits.some((h) => h.id === blockId)).toBe(true)
  })
})
