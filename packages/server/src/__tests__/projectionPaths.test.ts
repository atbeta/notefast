/**
 * 投影路径工具（RFC 0007 D2/D6）。
 *
 * 重点是**忽略规则与 vault 的分歧**：vault 忽略「任一段以 `.` 开头」，
 * 对用户自选的笔记文件夹过于激进（`.notes`、`.drafts` 会被整棵藏起来）。
 * 投影只按命名忽略表排除明确不属于笔记的东西。
 */

import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import {
  DEFAULT_IGNORED_DIRS,
  ProjectionPathError,
  isIgnoredRelPath,
  isMarkdownPath,
  isProjectionConflictName,
  normalizeRelPath,
  titleFromRelPath,
  toProjectionAbsPath,
  toProjectionRelPath,
} from '../projection/paths'

const ROOT = '/tmp/nf-projection-root'

describe('normalizeRelPath', () => {
  test('去 ./ 前缀、首尾斜杠，反斜杠转正斜杠', () => {
    expect(normalizeRelPath('./a/b.md')).toBe('a/b.md')
    expect(normalizeRelPath('a\\b.md')).toBe('a/b.md')
    expect(normalizeRelPath('/a/b.md/')).toBe('a/b.md')
    expect(normalizeRelPath('a/b.md')).toBe('a/b.md')
  })
})

describe('isMarkdownPath', () => {
  test('认 .md 与 .markdown，大小写不敏感；其他扩展名不认', () => {
    expect(isMarkdownPath('a.md')).toBe(true)
    expect(isMarkdownPath('a.MD')).toBe(true)
    expect(isMarkdownPath('a.markdown')).toBe(true)
    expect(isMarkdownPath('a.txt')).toBe(false)
    expect(isMarkdownPath('a.md.bak')).toBe(false)
    expect(isMarkdownPath('a.png')).toBe(false)
  })
})

describe('toProjectionRelPath：越界守卫', () => {
  test('相对路径正常解析', () => {
    expect(toProjectionRelPath(ROOT, 'a/b.md')).toBe('a/b.md')
    expect(toProjectionRelPath(ROOT, './a/b.md')).toBe('a/b.md')
  })

  test('绝对路径在根内正常解析', () => {
    expect(toProjectionRelPath(ROOT, join(ROOT, 'a/b.md'))).toBe('a/b.md')
  })

  test('.. 越界抛错', () => {
    expect(() => toProjectionRelPath(ROOT, '../outside.md')).toThrow(ProjectionPathError)
    expect(() => toProjectionRelPath(ROOT, 'a/../../outside.md')).toThrow(ProjectionPathError)
  })

  test('绝对路径在根外抛错', () => {
    expect(() => toProjectionRelPath(ROOT, '/etc/passwd')).toThrow(ProjectionPathError)
  })

  test('根本身抛错（不是一个文件）', () => {
    expect(() => toProjectionRelPath(ROOT, '.')).toThrow(ProjectionPathError)
    expect(() => toProjectionRelPath(ROOT, ROOT)).toThrow(ProjectionPathError)
  })

  test('toProjectionAbsPath 往返', () => {
    const abs = toProjectionAbsPath(ROOT, 'a/b.md')
    expect(abs).toBe(resolve(ROOT, 'a', 'b.md'))
    expect(toProjectionRelPath(ROOT, abs)).toBe('a/b.md')
  })
})

describe('isIgnoredRelPath：与 vault 的分歧（本模块的主要行为差异）', () => {
  test('隐藏**目录**不再整棵忽略：.notes 是用户的正当组织方式', () => {
    expect(isIgnoredRelPath('.notes/a.md')).toBe(false)
    expect(isIgnoredRelPath('.drafts/2026/a.md')).toBe(false)
    expect(isIgnoredRelPath('a/.hidden-notes/b.md')).toBe(false)
  })

  test('命名忽略目录仍被排除', () => {
    expect(isIgnoredRelPath('.obsidian/workspace.json')).toBe(true)
    expect(isIgnoredRelPath('.git/HEAD')).toBe(true)
    expect(isIgnoredRelPath('node_modules/pkg/a.md')).toBe(true)
    expect(isIgnoredRelPath('a/.trash/b.md')).toBe(true)
  })

  test('命名忽略目录按整段匹配：.obsidian-notes 不被误伤', () => {
    expect(isIgnoredRelPath('.obsidian-notes/a.md')).toBe(false)
    expect(isIgnoredRelPath('a/.gitlab/b.md')).toBe(false)
  })

  test('隐藏文件忽略（.DS_Store / 编辑器临时文件）', () => {
    expect(isIgnoredRelPath('.DS_Store')).toBe(true)
    expect(isIgnoredRelPath('a/.swp')).toBe(true)
    expect(isIgnoredRelPath('.a.md')).toBe(true)
  })

  test('额外的 ignore 前缀按整段匹配', () => {
    expect(isIgnoredRelPath('archive/a.md', ['archive'])).toBe(true)
    expect(isIgnoredRelPath('archive-2025/a.md', ['archive'])).toBe(false)
    // 前缀匹配的是**目录段**：'a/b' 只吃掉 a/b 及其子树，不吃掉 a/b.md 这个文件
    expect(isIgnoredRelPath('a/b/c.md', ['a/b'])).toBe(true)
    expect(isIgnoredRelPath('a/b.md', ['a/b'])).toBe(false)
  })

  test('普通路径不忽略', () => {
    expect(isIgnoredRelPath('notes/a.md')).toBe(false)
    expect(isIgnoredRelPath('我的笔记/子目录/b.md')).toBe(false)
  })

  test('冲突副本**不**忽略：它是用户文件，应当被导入让用户看见', () => {
    expect(isIgnoredRelPath('a.notefast-conflict-20260926-120000.md')).toBe(false)
    expect(isIgnoredRelPath('notes/a.notefast-conflict-20260926-120000.md')).toBe(false)
  })

  test('空路径忽略', () => {
    expect(isIgnoredRelPath('')).toBe(true)
  })

  test('DEFAULT_IGNORED_DIRS 是命名表，不是「点开头」规则', () => {
    expect(DEFAULT_IGNORED_DIRS).toContain('.obsidian')
    expect(DEFAULT_IGNORED_DIRS).toContain('node_modules')
    // 不能有通配形态，否则又退化成整棵忽略
    expect(DEFAULT_IGNORED_DIRS.every((d) => !d.includes('*'))).toBe(true)
  })
})

describe('isProjectionConflictName', () => {
  test('认 <stem>.notefast-conflict-<stamp>.md', () => {
    expect(isProjectionConflictName('a.notefast-conflict-20260926-120000.md')).toBe(true)
    expect(isProjectionConflictName('notes/a.notefast-conflict-x.md')).toBe(true)
  })

  test('近似名不认', () => {
    expect(isProjectionConflictName('a.md')).toBe(false)
    expect(isProjectionConflictName('a.notefast-conflict.md')).toBe(false) // 缺中缀前的点
    expect(isProjectionConflictName('notefast-conflict-a.md')).toBe(false)
    expect(isProjectionConflictName('a.notefast-conflict-x.png')).toBe(false)
  })
})

describe('titleFromRelPath', () => {
  test('取文件名去扩展名', () => {
    expect(titleFromRelPath('notes/我的笔记.md')).toBe('我的笔记')
    expect(titleFromRelPath('a.MD')).toBe('a')
    expect(titleFromRelPath('deep/a/b.markdown')).toBe('b')
  })

  test('空名给回退标题', () => {
    expect(titleFromRelPath('.md')).toBeTruthy()
    expect(titleFromRelPath('notes/')).toBe('notes')
  })
})
