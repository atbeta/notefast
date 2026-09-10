/**
 * vault 目录树（RFC 0005 U-8）：聚合口径单测。
 *
 * 覆盖：直接/递归计数、只统计 .md、忽略目录整棵不计、按层拉取、排序、路径规范化。
 */

import { describe, test, expect } from 'bun:test'
import { buildVaultTree, type VaultTreeEntry } from '../vault/tree'
import { DEFAULT_VAULT_IGNORE } from '../vault/config'

const entries: VaultTreeEntry[] = [
  { relPath: 'a.md', docId: 'd-a' },
  { relPath: 'zeta.md', docId: 'd-z' },
  { relPath: 'notes/b.md', docId: 'd-b' },
  { relPath: 'notes/b2.md', docId: 'd-b2' },
  { relPath: 'notes/books/c.md', docId: 'd-c' },
  { relPath: 'notes/books/deep/d.md', docId: 'd-d' },
  { relPath: 'notes/cover.png', docId: 'd-img' },
  { relPath: '.trash/trashed.md', docId: 'd-trash' },
  { relPath: '.obsidian/workspace.md', docId: 'd-obs' },
  { relPath: 'notes/.hidden/secret.md', docId: 'd-hidden' },
]

const opts = { ignore: [...DEFAULT_VAULT_IGNORE] }

describe('buildVaultTree', () => {
  test('根层：出直接子目录与根下的 .md，计数分别是直接/递归', () => {
    const level = buildVaultTree(entries, opts)
    expect(level.path).toBe('')
    expect(level.dirs.map((d) => d.path)).toEqual(['notes'])
    const notes = level.dirs[0]!
    expect(notes.name).toBe('notes')
    expect(notes.files).toBe(2) // b.md / b2.md
    expect(notes.total).toBe(4) // b.md + b2.md + books/c.md + books/deep/d.md
    expect(level.files.map((f) => f.name)).toEqual(['a', 'zeta']) // 按名排序
    expect(level.files.map((f) => f.doc_id)).toEqual(['d-a', 'd-z'])
  })

  test('第二层：只出下一级目录，文件列表是本目录的直接 .md', () => {
    const level = buildVaultTree(entries, { ...opts, path: 'notes' })
    expect(level.dirs.map((d) => [d.path, d.files, d.total])).toEqual([['notes/books', 1, 2]])
    expect(level.files.map((f) => f.path)).toEqual(['notes/b.md', 'notes/b2.md'])
  })

  test('第三层：deep 目录的计数与文件', () => {
    const level = buildVaultTree(entries, { ...opts, path: 'notes/books' })
    expect(level.dirs.map((d) => [d.path, d.files, d.total])).toEqual([['notes/books/deep', 1, 1]])
    expect(level.files.map((f) => f.path)).toEqual(['notes/books/c.md'])
  })

  test('只统计 .md：附件不进树，也不影响计数', () => {
    const level = buildVaultTree(entries, { ...opts, path: 'notes' })
    expect(level.files.some((f) => f.path.endsWith('.png'))).toBe(false)
  })

  test('忽略目录整棵不计（.trash / .obsidian / 隐藏目录）', () => {
    const flat = JSON.stringify(buildVaultTree(entries, opts))
    expect(flat).not.toContain('.trash')
    expect(flat).not.toContain('.obsidian')
    expect(flat).not.toContain('secret')
    // 隐藏目录里的文件也不计入 notes 的递归数
    expect(buildVaultTree(entries, { ...opts, path: 'notes' }).dirs.map((d) => d.path)).toEqual([
      'notes/books',
    ])
  })

  test('不存在的目录：空结果而不是报错', () => {
    const level = buildVaultTree(entries, { ...opts, path: 'nope' })
    expect(level).toEqual({ path: 'nope', dirs: [], files: [] })
  })

  test('路径头尾斜杠 / 空输入都归一化', () => {
    const a = buildVaultTree(entries, { ...opts, path: '/notes/' })
    const b = buildVaultTree(entries, { ...opts, path: 'notes' })
    expect(a).toEqual(b)
    expect(buildVaultTree([], opts)).toEqual({ path: '', dirs: [], files: [] })
  })

  test('同名目录按名自然排序（数字按数值比较）', () => {
    const level = buildVaultTree(
      [
        { relPath: 'ch10/a.md', docId: '1' },
        { relPath: 'ch2/b.md', docId: '2' },
        { relPath: 'ch1/c.md', docId: '3' },
      ],
      opts,
    )
    expect(level.dirs.map((d) => d.name)).toEqual(['ch1', 'ch2', 'ch10'])
  })

  test('只有深层文件时，中间目录仍然出现（计数不丢层）', () => {
    const level = buildVaultTree([{ relPath: 'x/y/z/deep.md', docId: '1' }], opts)
    expect(level.dirs.map((d) => [d.path, d.files, d.total])).toEqual([['x', 0, 1]])
    expect(buildVaultTree([{ relPath: 'x/y/z/deep.md', docId: '1' }], { ...opts, path: 'x' }).dirs)
      .toEqual([{ path: 'x/y', name: 'y', files: 0, total: 1 }])
  })
})
