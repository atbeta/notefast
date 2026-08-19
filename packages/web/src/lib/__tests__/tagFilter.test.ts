import { describe, expect, test } from 'bun:test'
import {
  catalogWithSelected,
  chipCountForRows,
  isAdditiveTagClick,
  nextTagSelection,
  readSelectedTags,
} from '../tagFilter'

describe('readSelectedTags', () => {
  test('读 tags 多选并去重排序', () => {
    expect(readSelectedTags(new URLSearchParams('tags=sqlite,mcp'))).toEqual(['mcp', 'sqlite'])
  })

  test('兼容旧 ?tag= 并与 tags 合并', () => {
    expect(readSelectedTags(new URLSearchParams('tags=mcp&tag=sqlite'))).toEqual(['mcp', 'sqlite'])
  })
})

describe('catalogWithSelected', () => {
  const all = [
    { tag: 'a', count: 9 },
    { tag: 'b', count: 8 },
  ]

  test('不把已选钉到最前，保持 count 顺序', () => {
    expect(catalogWithSelected(all, ['b']).map((t) => t.tag)).toEqual(['a', 'b'])
  })

  test('列表没有的已选跟在末尾', () => {
    expect(catalogWithSelected(all, ['ghost'])).toEqual([
      ...all,
      { tag: 'ghost', count: 0 },
    ])
  })
})

describe('chipCountForRows', () => {
  test('一行能放下则全部展示', () => {
    expect(chipCountForRows([20, 20, 20], 100, 8, 2, 24)).toBe(3)
  })

  test('两行刚好放下则无需展开', () => {
    // 行1: 40+8+40=88；行2: 40+8+40=88
    expect(chipCountForRows([40, 40, 40, 40], 100, 8, 2, 24)).toBe(4)
  })

  test('超出两行时最后一行给展开按钮留位', () => {
    // 行1: 两个 40；行2 只能再放一个 40 + 按钮，第 4、5 颗收起
    expect(chipCountForRows([40, 40, 40, 40, 40], 100, 8, 2, 24)).toBe(3)
  })

  test('尚未布局时不截断', () => {
    expect(chipCountForRows([40, 40, 40], 0, 8, 2, 24)).toBe(3)
  })
})

describe('nextTagSelection', () => {
  test('单击未选中 → 替换为单选', () => {
    expect(nextTagSelection(['mcp'], 'sqlite', false)).toEqual(['sqlite'])
    expect(nextTagSelection([], 'mcp', false)).toEqual(['mcp'])
  })

  test('单击已选中 → 去掉该项；最后一项则清空', () => {
    expect(nextTagSelection(['mcp', 'sqlite'], 'mcp', false)).toEqual(['sqlite'])
    expect(nextTagSelection(['mcp'], 'mcp', false)).toEqual([])
  })

  test('⌘/Ctrl 在当前选择上加/减', () => {
    expect(nextTagSelection(['mcp'], 'sqlite', true)).toEqual(['mcp', 'sqlite'])
    expect(nextTagSelection(['mcp', 'sqlite'], 'mcp', true)).toEqual(['sqlite'])
  })
})

describe('isAdditiveTagClick', () => {
  test('meta 或 ctrl 视为加选', () => {
    expect(isAdditiveTagClick({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(isAdditiveTagClick({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(isAdditiveTagClick({ metaKey: false, ctrlKey: false })).toBe(false)
  })
})
