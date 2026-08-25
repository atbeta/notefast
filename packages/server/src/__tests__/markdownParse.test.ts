import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { parseMarkdownToBlocks } from '@notefast/core'
import { parseMarkdownToBlocksForSave, readMarkdownParserMode } from '../services/markdownParse'

function shape(inputs: ReturnType<typeof parseMarkdownToBlocks>) {
  return inputs.map((i) => ({ type: i.type, content: i.content, properties: i.properties }))
}

const ENV_KEY = 'NOTEFAST_MARKDOWN_PARSER'

let saved: string | undefined

beforeEach(() => {
  saved = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = saved
})

describe('readMarkdownParserMode', () => {
  test('未设置或未知值都是 legacy', () => {
    expect(readMarkdownParserMode()).toBe('legacy')
    process.env[ENV_KEY] = 'mdast'
    expect(readMarkdownParserMode()).toBe('legacy')
    process.env[ENV_KEY] = 'SHADOW'
    expect(readMarkdownParserMode()).toBe('shadow')
  })
})

describe('parseMarkdownToBlocksForSave', () => {
  test('默认写入与手写 parser 一致', () => {
    const md = '# 标题\n\n正文\n'
    expect(shape(parseMarkdownToBlocksForSave(md, 'nb'))).toEqual(shape(parseMarkdownToBlocks(md, 'nb')))
  })

  test('shadow 仍写入手写结果，围栏差异只打 warn 不含正文', () => {
    process.env[ENV_KEY] = 'shadow'
    const md = '~~~\nsecret-code\n~~~\n'
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '))
    }
    try {
      const out = parseMarkdownToBlocksForSave(md, 'nb')
      expect(shape(out)).toEqual(shape(parseMarkdownToBlocks(md, 'nb')))
    } finally {
      console.warn = orig
    }
    expect(warns.some((line) => line.includes('semantic mismatch'))).toBe(true)
    expect(warns.some((line) => line.includes('0.type'))).toBe(true)
    expect(warns.join('\n')).not.toContain('secret-code')
  })
})
