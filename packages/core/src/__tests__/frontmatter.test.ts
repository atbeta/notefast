import { describe, expect, test } from 'bun:test'
import {
  docFrontmatterFromRow,
  formatDocFrontmatter,
  parseImportedTimestamp,
  patchFrontmatter,
  stripDocFrontmatter,
  withDocFrontmatter,
} from '../frontmatter'

describe('frontmatter export projection', () => {
  test('formatDocFrontmatter 含 tags / 时间 / notefast_id', () => {
    const fm = formatDocFrontmatter({
      tags: ['ai', 'rag'],
      created: '2025-01-15 10:00:00.000',
      modified: '2025-01-20 12:00:00.000',
      notefast_id: 'doc-abc',
    })
    expect(fm.startsWith('---\n')).toBe(true)
    expect(fm).toContain('tags:')
    expect(fm).toContain('  - ai')
    expect(fm).toContain('  - rag')
    expect(fm).toContain('notefast_id: doc-abc')
    expect(fm).toContain('created:')
    expect(fm).toContain('2025-01-15 10:00:00.000')
    expect(fm).toContain('modified:')
    expect(fm).toContain('2025-01-20 12:00:00.000')
    expect(fm.endsWith('---\n\n') || fm.endsWith('---\n')).toBe(true)
  })

  test('空 tags 写 tags: []', () => {
    const fm = formatDocFrontmatter({
      tags: [],
      created: 't1',
      modified: 't2',
      notefast_id: 'id1',
    })
    expect(fm).toContain('tags: []')
  })

  test('withDocFrontmatter 拼在正文前', () => {
    const out = withDocFrontmatter('# Title\n\nbody\n', {
      tags: ['x'],
      created: 'c',
      modified: 'm',
      notefast_id: 'id',
    })
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('# Title')
    expect(out).toContain('body')
  })

  test('docFrontmatterFromRow 读 tags 列', () => {
    const meta = docFrontmatterFromRow({
      id: 'root-1',
      tags: '["Hello","World"]',
      created_at: 'c',
      updated_at: 'u',
    })
    expect(meta.notefast_id).toBe('root-1')
    expect(meta.tags).toEqual(['hello', 'world'])
    expect(meta.created).toBe('c')
    expect(meta.modified).toBe('u')
  })

  test('stripDocFrontmatter 往返', () => {
    const body = '# Hi\n\npara\n'
    const full = withDocFrontmatter(body, {
      tags: ['a', 'b'],
      created: '2025-01-01 10:00:00.000',
      modified: '2025-01-02 12:00:00.000',
      notefast_id: 'nid',
    })
    const stripped = stripDocFrontmatter(full)
    expect(stripped.meta?.tags).toEqual(['a', 'b'])
    expect(stripped.meta?.notefast_id).toBe('nid')
    expect(stripped.meta?.created).toBe('2025-01-01 10:00:00.000')
    expect(stripped.meta?.modified).toBe('2025-01-02 12:00:00.000')
    expect(stripped.body).toBe(body)
  })

  test('parseImportedTimestamp 收成 DB 时间串', () => {
    expect(parseImportedTimestamp('2025-01-15 10:00:00.000')).toBe('2025-01-15 10:00:00.000')
    expect(parseImportedTimestamp('2025-01-15T10:00:00.000Z')).toBe('2025-01-15 10:00:00.000')
    expect(parseImportedTimestamp('2025-01-15')).toBe('2025-01-15 00:00:00.000')
    expect(parseImportedTimestamp('yesterday')).toBeNull()
    expect(parseImportedTimestamp(undefined)).toBeNull()
  })

  test('无 frontmatter 原样返回', () => {
    const md = '# Title\n\n---\nnot a fm\n'
    const stripped = stripDocFrontmatter(md)
    expect(stripped.meta).toBeNull()
    expect(stripped.body).toBe(md)
  })

  test('需引号的 tag 可往返', () => {
    const full = withDocFrontmatter('x\n', {
      tags: ['a:b', 'has space'],
      created: 'c',
      modified: 'm',
      notefast_id: 'id',
    })
    const { meta } = stripDocFrontmatter(full)
    expect(meta?.tags).toEqual(['a:b', 'has space'])
  })

  test('stripDocFrontmatter 返回 raw 原文（不含首尾 ---）', () => {
    const md = '---\naliases:\n  - NF\ntags:\n  - x\n---\nbody\n'
    const stripped = stripDocFrontmatter(md)
    expect(stripped.raw).toBe('aliases:\n  - NF\ntags:\n  - x\n')
    expect(stripped.body).toBe('body\n')
    expect(stripDocFrontmatter('no frontmatter\n').raw).toBeNull()
  })

  test('tags 三种写法都能读：块列表 / 内联流式 / 单标量', () => {
    // 读取只解引号，不做归一化（小写 / 空格折叠由 ingest、docImport 的 normalizeTagList 负责）
    expect(stripDocFrontmatter('---\ntags:\n  - A\n  - b\n---\nx\n').meta?.tags).toEqual(['A', 'b'])
    expect(stripDocFrontmatter('---\ntags: [A, "b c"]\n---\nx\n').meta?.tags).toEqual(['A', 'b c'])
    expect(stripDocFrontmatter('---\ntags: Dev\n---\nx\n').meta?.tags).toEqual(['Dev'])
    expect(stripDocFrontmatter('---\ntags: []\n---\nx\n').meta?.tags).toEqual([])
    expect(stripDocFrontmatter('---\ntags: [a, , b]\n---\nx\n').meta?.tags).toEqual(['a', 'b'])
  })

  test('只有用户自定义字段的 frontmatter 也会被剥离（不再整段当正文）', () => {
    const md = '---\naliases:\n  - NF\ncssclasses: [wide]\ndescription: |\n  两行\n  说明\n---\nbody\n'
    const r = stripDocFrontmatter(md)
    expect(r.meta).toEqual({})
    expect(r.raw).toBe('aliases:\n  - NF\ncssclasses: [wide]\ndescription: |\n  两行\n  说明\n')
    expect(r.body).toBe('body\n')
  })

  test('以 --- 开头的普通正文不被误判成 frontmatter', () => {
    const md = '---\n\n这是正文第一段\n\n---\n\n后面还有内容\n'
    const r = stripDocFrontmatter(md)
    expect(r.meta).toBeNull()
    expect(r.body).toBe(md)

    // 带冒号的散文同样不算（避免「Note: ...」被当成 YAML 键）
    const prose = '---\nNote: 这是正文\n后面还有散文\n---\nx\n'
    expect(stripDocFrontmatter(prose).meta).toBeNull()
    expect(stripDocFrontmatter(prose).body).toBe(prose)
  })

  test('notefast_ai_exclude / notefast_status 解析（非法值忽略但仍是 frontmatter）', () => {
    const read = (yaml: string) => stripDocFrontmatter(`---\n${yaml}\n---\nx\n`)
    expect(read('notefast_ai_exclude: true').meta?.notefast_ai_exclude).toBe(true)
    expect(read('notefast_ai_exclude: false').meta?.notefast_ai_exclude).toBe(false)
    expect(read('notefast_ai_exclude: "true"').meta?.notefast_ai_exclude).toBe(true)
    expect(read('notefast_status: inbox').meta?.notefast_status).toBe('inbox')
    expect(read('notefast_status: note').meta?.notefast_status).toBe('note')

    const bad = read('notefast_status: archived')
    expect(bad.meta?.notefast_status).toBeUndefined()
    expect(bad.body).toBe('x\n')
    expect(read('notefast_ai_exclude: yes').meta?.notefast_ai_exclude).toBeUndefined()
  })
})

describe('patchFrontmatter（vault 写回行级透传，RFC 0003 阶段 B）', () => {
  test('只改 tags，其余行逐字节保留', () => {
    const raw = [
      'aliases:',
      '  - NF',
      'cssclasses: [wide, dark]',
      'custom_key: keep me',
      'tags:',
      '  - old',
    ].join('\n')
    expect(patchFrontmatter(raw, { tags: ['new', 'a:b'] })).toBe(
      [
        'aliases:',
        '  - NF',
        'cssclasses: [wide, dark]',
        'custom_key: keep me',
        'tags:',
        '  - new',
        '  - "a:b"',
      ].join('\n'),
    )
  })

  test('内联与单标量写法统一改写为块列表', () => {
    expect(patchFrontmatter('tags: [a, b]', { tags: ['a', 'b'] })).toBe('tags:\n  - a\n  - b')
    expect(patchFrontmatter('tags: solo', { tags: ['solo'] })).toBe('tags:\n  - solo')
    expect(patchFrontmatter('tags: []', { tags: ['x'] })).toBe('tags:\n  - x')
  })

  test('tags 为空 / null → 删除该键，其余键不受影响', () => {
    expect(patchFrontmatter('aliases:\n  - NF\ntags:\n  - x', { tags: [] })).toBe('aliases:\n  - NF')
    expect(patchFrontmatter('tags: [x]', { tags: null })).toBe('')
  })

  test('键不存在 → 末尾插入', () => {
    expect(patchFrontmatter('aliases:\n  - NF', { tags: ['x'] })).toBe('aliases:\n  - NF\ntags:\n  - x')
  })

  test('raw 为 null：按 patch 从零生成；patch 全空 → 空串', () => {
    expect(patchFrontmatter(null, {})).toBe('')
    expect(patchFrontmatter(null, { tags: [] })).toBe('')
    expect(patchFrontmatter(null, { tags: ['a'] })).toBe('tags:\n  - a')
    expect(
      patchFrontmatter(null, { tags: ['a'], notefast_ai_exclude: true, notefast_status: 'inbox' }),
    ).toBe('tags:\n  - a\nnotefast_ai_exclude: true\nnotefast_status: inbox')
    // 缺省值不写键
    expect(patchFrontmatter(null, { notefast_ai_exclude: false, notefast_status: 'note' })).toBe('')
  })

  test('notefast_ai_exclude / notefast_status：非缺省写入，缺省删除已有键', () => {
    const raw = 'notefast_ai_exclude: true\nnotefast_status: inbox\naliases:\n  - NF'
    expect(patchFrontmatter(raw, { notefast_ai_exclude: false, notefast_status: 'note' })).toBe('aliases:\n  - NF')
    expect(patchFrontmatter('aliases:\n  - NF', { notefast_ai_exclude: true })).toBe(
      'aliases:\n  - NF\nnotefast_ai_exclude: true',
    )
    expect(patchFrontmatter('notefast_status: inbox', { notefast_status: 'inbox' })).toBe('notefast_status: inbox')
  })

  test('未出现在 patch 里的键绝不触碰', () => {
    const raw = 'notefast_ai_exclude: true\ntags:\n  - x'
    expect(patchFrontmatter(raw, { tags: ['x'] })).toBe(raw)
    expect(patchFrontmatter(raw, {})).toBe(raw)
  })

  test('嵌套的同名键不被误判为顶层键', () => {
    const raw = 'meta:\n  tags: nested\ncustom: 1'
    expect(patchFrontmatter(raw, { tags: ['x'] })).toBe('meta:\n  tags: nested\ncustom: 1\ntags:\n  - x')
  })

  test('顶部 / 尾部空白折叠，中间空行保留', () => {
    const raw = '\n\naliases:\n  - NF\n\ntags:\n  - x\n\n'
    expect(patchFrontmatter(raw, { tags: ['x'] })).toBe('aliases:\n  - NF\n\ntags:\n  - x')
  })
})
