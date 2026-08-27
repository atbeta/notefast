import { describe, expect, test } from 'bun:test'
import { htmlToMarkdown } from '../htmlToMarkdown'

describe('htmlToMarkdown', () => {
  test('标题上的 bookmark 锚点不进入正文', () => {
    const md = htmlToMarkdown('<h1 id="_Toc123456"><a id="_Toc123456"></a>第一章 概述</h1><p>正文</p>')
    expect(md).toBe('# 第一章 概述\n\n正文')
    expect(md).not.toContain('<a')
    expect(md).not.toContain('_Toc')
  })

  test('未知 / 命名空间标签只留文本', () => {
    const md = htmlToMarkdown('<h2><w:bookmarkStart/>残留标题</h2><p>段</p>')
    expect(md).toBe('## 残留标题\n\n段')
    expect(md).not.toMatch(/<w:/)
  })

  test('加粗斜体链接图片', () => {
    const md = htmlToMarkdown(
      '<p>看 <strong>粗</strong> 和 <em>斜</em>，<a href="https://a.example">链</a></p><p><img src="asset:abc" alt="图"/></p>',
    )
    expect(md).toContain('**粗**')
    expect(md).toContain('*斜*')
    expect(md).toContain('[链](https://a.example)')
    expect(md).toContain('![图](asset:abc)')
  })

  test('列表与表格', () => {
    const md = htmlToMarkdown(
      '<ul><li>甲</li><li>乙</li></ul><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>',
    )
    expect(md).toContain('- 甲')
    expect(md).toContain('- 乙')
    expect(md).toContain('| A | B |')
    expect(md).toContain('| 1 | 2 |')
  })

  test('空锚点链接不当成超链接', () => {
    expect(htmlToMarkdown('<p><a id="x"></a>纯文字</p>')).toBe('纯文字')
  })
})
