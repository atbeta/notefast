import { describe, test, expect } from 'bun:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import { classifyChatMath } from '../chatMath'

// 最小 hast/mdast 结构类型：只为测试遍历服务，避免额外引入 @types/hast / @types/mdast 依赖
interface TestNode {
  type: string
  tagName?: string
  value?: string
  lang?: string
  properties?: { className?: unknown }
  children?: TestNode[]
}

/** 与 react-markdown 内部同款管线：remark-parse → remark-math → remark-rehype */
function parseToHast(src: string): TestNode {
  const processor = unified().use(remarkParse).use(remarkMath).use(remarkRehype)
  return processor.runSync(processor.parse(src)) as unknown as TestNode
}

function parseToMdast(src: string): TestNode {
  const processor = unified().use(remarkParse).use(remarkMath)
  return processor.parse(src) as unknown as TestNode
}

/** 收集 hast 中全部 code 元素的 className 数组（react-markdown 传给组件前再 join 成字符串） */
function codeClassNames(root: TestNode): string[][] {
  const out: string[][] = []
  const visit = (n: TestNode) => {
    if (n.type === 'element' && n.tagName === 'code') {
      out.push((n.properties?.className as string[] | undefined) ?? [])
    }
    n.children?.forEach(visit)
  }
  visit(root)
  return out
}

function collectMdast(root: TestNode, type: string): TestNode[] {
  const out: TestNode[] = []
  const visit = (n: TestNode) => {
    if (n.type === type) out.push(n)
    n.children?.forEach(visit)
  }
  visit(root)
  return out
}

describe('remark-math 解析行为（钉住 mdast-util-math@3 输出约定）', () => {
  test('行内 $...$ → inlineMath，hast className 为 language-math math-inline', () => {
    const mdast = parseToMdast('质能方程 $x^2$ 结束')
    expect(collectMdast(mdast, 'inlineMath').map((n) => n.value)).toEqual(['x^2'])
    expect(codeClassNames(parseToHast('质能方程 $x^2$ 结束'))).toEqual([['language-math', 'math-inline']])
  })

  test('多行 $$ 围栏形式 → math 节点，hast className 为 language-math math-display', () => {
    const src = '前\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n后'
    expect(collectMdast(parseToMdast(src), 'math')).toHaveLength(1)
    expect(codeClassNames(parseToHast(src))).toEqual([['language-math', 'math-display']])
  })

  test('单行 $$x^2$$ 是 inlineMath 而非 display（反直觉行为，钉住防升级漂移）', () => {
    expect(collectMdast(parseToMdast('$$x^2$$'), 'math')).toHaveLength(0)
    expect(codeClassNames(parseToHast('$$x^2$$'))).toEqual([['language-math', 'math-inline']])
  })

  // 已知接受项：micromark-extension-math 无 Pandoc 空白/数字守卫，
  // 货币区间会被解析为数学。靠服务端 prompt 约定 + MathInline 渲染失败回退原文兜底
  test('货币 $5 - $10 会被解析为 inlineMath（无 Pandoc 守卫，已知接受项）', () => {
    expect(collectMdast(parseToMdast('价格在 $5 - $10 之间'), 'inlineMath').map((n) => n.value)).toEqual(['5 - '])
    expect(collectMdast(parseToMdast('区间 $5-$10 左右'), 'inlineMath').map((n) => n.value)).toEqual(['5-'])
    expect(collectMdast(parseToMdast('从 $100 到 $200'), 'inlineMath').map((n) => n.value)).toEqual(['100 到 '])
  })

  test('```math 围栏是普通 code 节点，className 仅 language-math（无 inline/display 标记）', () => {
    const mdast = parseToMdast('```math\nx^2\n```')
    expect(collectMdast(mdast, 'code').map((n) => n.lang)).toEqual(['math'])
    expect(codeClassNames(parseToHast('```math\nx^2\n```'))).toEqual([['language-math']])
  })

  test('```latex 别名围栏 → language-latex', () => {
    expect(codeClassNames(parseToHast('```latex\nx^2\n```'))).toEqual([['language-latex']])
  })

  test('行内代码 `$x$` 不进数学解析', () => {
    expect(collectMdast(parseToMdast('`$x$` 是代码'), 'inlineMath')).toHaveLength(0)
    expect(codeClassNames(parseToHast('`$x$` 是代码'))).toEqual([[]])
  })
})

describe('classifyChatMath（code className → 数学类型）', () => {
  test('math-inline / math-display 标记', () => {
    expect(classifyChatMath('language-math math-inline')).toBe('inline')
    expect(classifyChatMath('language-math math-display')).toBe('display')
    // 无 language- 前缀的裸标记也能识别（防御性）
    expect(classifyChatMath('math-inline')).toBe('inline')
    expect(classifyChatMath('math-display')).toBe('display')
  })

  test('```math 围栏及 latex/katex/tex 别名按块级处理', () => {
    expect(classifyChatMath('language-math')).toBe('display')
    expect(classifyChatMath('language-latex')).toBe('display')
    expect(classifyChatMath('language-katex')).toBe('display')
    expect(classifyChatMath('language-tex')).toBe('display')
  })

  test('普通代码语言与 mermaid 不误判', () => {
    expect(classifyChatMath('language-js')).toBeNull()
    expect(classifyChatMath('language-mermaid')).toBeNull()
    expect(classifyChatMath('language-maths')).toBeNull()
  })

  test('无 className', () => {
    expect(classifyChatMath(undefined)).toBeNull()
    expect(classifyChatMath('')).toBeNull()
  })

  test('端到端：真实解析输出的 className 进分派', () => {
    const inline = codeClassNames(parseToHast('质能方程 $x^2$ 结束'))[0].join(' ')
    expect(classifyChatMath(inline)).toBe('inline')
    const display = codeClassNames(parseToHast('$$\nx^2\n$$'))[0].join(' ')
    expect(classifyChatMath(display)).toBe('display')
    const fence = codeClassNames(parseToHast('```math\nx^2\n```'))[0].join(' ')
    expect(classifyChatMath(fence)).toBe('display')
  })
})
