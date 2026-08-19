import { describe, expect, test } from 'bun:test'
import { splitCiteParts } from '../chatCites'

describe('splitCiteParts', () => {
  test('maxCite<1 原样返回', () => {
    expect(splitCiteParts('hello [1]', 0)).toEqual([{ type: 'text', value: 'hello [1]' }])
  })

  test('拆出范围内的 [n]', () => {
    expect(splitCiteParts('dogfooding[5] 与 Charles[3]', 5)).toEqual([
      { type: 'text', value: 'dogfooding' },
      { type: 'cite', n: 5 },
      { type: 'text', value: ' 与 Charles' },
      { type: 'cite', n: 3 },
    ])
  })

  test('超出 maxCite 的编号保持原文', () => {
    expect(splitCiteParts('见 [9] 与 [2]', 5)).toEqual([
      { type: 'text', value: '见 [9] 与 ' },
      { type: 'cite', n: 2 },
    ])
  })

  test('相邻引用', () => {
    expect(splitCiteParts('[1][2]', 2)).toEqual([
      { type: 'cite', n: 1 },
      { type: 'cite', n: 2 },
    ])
  })
})
