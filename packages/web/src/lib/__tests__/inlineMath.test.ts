import { describe, test, expect } from 'bun:test'
import { INLINE_MATH_SRC } from '../katex'

// 与 BlockRenderer 的组合方式一致：作为一个备选分支参与全文扫描
const RE = new RegExp(INLINE_MATH_SRC, 'g')

function matches(text: string): string[] {
  return Array.from(text.matchAll(RE), (m) => m[0])
}

describe('行内公式 $...$ 匹配（Pandoc 规则）', () => {
  test('常规公式命中', () => {
    expect(matches('质能方程 $E=mc^2$ 与 $x^2+y^2$')).toEqual(['$E=mc^2$', '$x^2+y^2$'])
  })

  test('内部允许空格，但分隔符内侧不允许', () => {
    expect(matches('$a + b$')).toEqual(['$a + b$'])
    expect(matches('$ a+b$')).toEqual([]) // 开 $ 后空格
    expect(matches('$a+b $')).toEqual([]) // 闭 $ 前空格
  })

  test('货币场景不误伤', () => {
    expect(matches('价格在 $100 与 $200 之间')).toEqual([])
    expect(matches('区间 $5-$10 左右')).toEqual([]) // 闭 $ 后跟数字
  })

  test('闭 $ 后跟数字不匹配（编号/金额）', () => {
    expect(matches('$x$2 不是公式')).toEqual([])
  })

  test('不跨行、不配对不命中', () => {
    expect(matches('$a\nb$')).toEqual([])
    expect(matches('只有开 $x 没有闭')).toEqual([])
  })

  test('正文中的公式后随标点仍命中', () => {
    expect(matches('如 $x^2$，继续')).toEqual(['$x^2$'])
  })
})
