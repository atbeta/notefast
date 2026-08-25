/**
 * Markdown 契约 corpus：按文件冻结现行 parser 语义。
 *
 * 成功样本：与 expected.json 一致，且默认 parse → serialize → parse 语义不变。
 * 失败样本：钉住「会丢 / 截断 / 认不出围栏」的现状；mdast 实现只允许这些条目改善。
 */

import { existsSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { parseMarkdownToBlocks, blocksToMarkdown } from '../../markdown'
import { inputsToOrderedBlocks, toSemanticForest } from '../../markdown/semantics'
import { FAILURE_FIXTURES, SUCCESS_FIXTURES } from './contract'
import { fixturePath, readExpected, readFixtureFile, readMeta } from './loadFixture'

describe('markdown corpus：成功样本覆盖清单', () => {
  test('每个成功 id 都有 .md 与 .expected.json', () => {
    for (const id of SUCCESS_FIXTURES) {
      expect(existsSync(fixturePath('success', `${id}.md`))).toBe(true)
      expect(existsSync(fixturePath('success', `${id}.expected.json`))).toBe(true)
    }
  })

  test('每个失败 id 都有 .md / .expected.json / .meta.json', () => {
    for (const id of FAILURE_FIXTURES) {
      expect(existsSync(fixturePath('failure', `${id}.md`))).toBe(true)
      expect(existsSync(fixturePath('failure', `${id}.expected.json`))).toBe(true)
      expect(existsSync(fixturePath('failure', `${id}.meta.json`))).toBe(true)
    }
  })
})

describe('markdown corpus：成功样本（现行 parser）', () => {
  for (const id of SUCCESS_FIXTURES) {
    test(id, () => {
      const markdown = readFixtureFile('success', `${id}.md`)
      const meta = readMeta('success', id)
      const parsed = parseMarkdownToBlocks(markdown, 'corpus')
      const forest = toSemanticForest(parsed)
      expect(forest).toEqual(readExpected('success', id))

      const roundtrip = meta.roundtrip !== false
      if (!roundtrip) return

      const exported = blocksToMarkdown(inputsToOrderedBlocks(parsed))
      const again = parseMarkdownToBlocks(exported, 'corpus')
      expect(toSemanticForest(again)).toEqual(forest)
    })
  }
})

describe('markdown corpus：失败样本（钉住现状，允许日后改善）', () => {
  for (const id of FAILURE_FIXTURES) {
    test(id, () => {
      const meta = readMeta('failure', id)
      expect(meta.allowImprove).toBe(true)
      expect(meta.defect).toBeTruthy()

      const markdown = readFixtureFile('failure', `${id}.md`)
      const forest = toSemanticForest(parseMarkdownToBlocks(markdown, 'corpus'))
      expect(forest).toEqual(readExpected('failure', id))
    })
  }
})
