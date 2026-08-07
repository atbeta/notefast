import { describe, test, expect } from 'bun:test'
import { sortPinnedViewsByName } from '../usePinnedViews'

function v(id: string, name: string) {
  return { id, name, query: 'tags=x', created_at: '2026-01-01T00:00:00Z' }
}

describe('固定视图按名称排序（sortPinnedViewsByName）', () => {
  test('数字前缀自然序：01- 在 2- 前、2- 在 10- 前', () => {
    const out = sortPinnedViewsByName([v('a', '10-工作'), v('b', '2-学习'), v('c', '01-生活')])
    expect(out.map((x) => x.name)).toEqual(['01-生活', '2-学习', '10-工作'])
  })

  test('英文按字母序（大小写不敏感）', () => {
    const out = sortPinnedViewsByName([v('a', 'Beta'), v('b', 'alpha'), v('c', 'Gamma')])
    expect(out.map((x) => x.name)).toEqual(['alpha', 'Beta', 'Gamma'])
  })

  test('中文按拼音排序', () => {
    const out = sortPinnedViewsByName([v('a', '工作'), v('b', '生活'), v('c', '学习')])
    expect(out.map((x) => x.name)).toEqual(['工作', '生活', '学习'])
  })

  test('不修改原数组（返回新数组）', () => {
    const src = [v('a', 'b'), v('c', 'a')]
    const out = sortPinnedViewsByName(src)
    expect(src.map((x) => x.name)).toEqual(['b', 'a'])
    expect(out.map((x) => x.name)).toEqual(['a', 'b'])
  })
})
