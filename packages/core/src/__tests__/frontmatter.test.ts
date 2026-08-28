import { describe, expect, test } from 'bun:test'
import {
  docFrontmatterFromRow,
  formatDocFrontmatter,
  parseImportedTimestamp,
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
})
