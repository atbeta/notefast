import { describe, expect, test } from 'bun:test'
import {
  ARCHIVE_UNTAGGED_DIR,
  archiveDirName,
  archiveFilename,
  archiveRelPath,
  buildArchiveManifest,
  staleArchiveKeys,
} from '../sync/archive'

describe('archiveDirName / archiveRelPath', () => {
  test('无标签 → untagged', () => {
    expect(archiveDirName([])).toBe(ARCHIVE_UNTAGGED_DIR)
    expect(archiveDirName(['', '  '])).toBe(ARCHIVE_UNTAGGED_DIR)
  })

  test('首标签作一层目录（插入序）', () => {
    expect(archiveDirName(['work', 'ai'])).toBe('work')
    expect(archiveDirName(['ai', 'work'])).toBe('ai')
  })

  test('标签里的斜杠换成连字符，不嵌套', () => {
    expect(archiveDirName(['a/b\\c'])).toBe('a-b-c')
  })

  test('相对路径 = 目录 + 稳定文件名', () => {
    const docId = 'abcdef12-3456-7890-abcd-ef1234567890'
    expect(archiveRelPath('Hello World', docId, [])).toBe(
      `${ARCHIVE_UNTAGGED_DIR}/${archiveFilename('Hello World', docId)}`,
    )
    expect(archiveRelPath('Hello World', docId, ['work'])).toBe(
      `work/${archiveFilename('Hello World', docId)}`,
    )
  })

  test('首标签变化 → 旧路径视为陈旧', () => {
    const prev = buildArchiveManifest({
      adapter: 'localfs',
      files: [{ docId: '1', title: 't', filename: 'untagged/t--abc.md', key: 'untagged/t--abc.md' }],
    })
    const curr = buildArchiveManifest({
      adapter: 'localfs',
      files: [{ docId: '1', title: 't', filename: 'work/t--abc.md', key: 'work/t--abc.md' }],
    })
    expect(staleArchiveKeys(prev, curr)).toEqual(['untagged/t--abc.md'])
  })
})
