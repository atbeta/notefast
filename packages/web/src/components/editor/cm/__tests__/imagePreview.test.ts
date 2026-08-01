import { describe, test, expect } from 'bun:test'
import { IMAGE_LINE_RE } from '../imagePreview'

describe('IMAGE_LINE_RE', () => {
  test('匹配单张图片行', () => {
    const m = IMAGE_LINE_RE.exec('![alt](https://example.com/x.png)')
    expect(m).not.toBeNull()
    expect(m?.[1]).toBe('alt')
    expect(m?.[2]).toBe('https://example.com/x.png')
  })

  test('支持带标题的图片语法', () => {
    const m = IMAGE_LINE_RE.exec('![alt](https://x.png "title")')
    expect(m).not.toBeNull()
    expect(m?.[2]).toBe('https://x.png')
  })

  test('asset: 引用命中', () => {
    const m = IMAGE_LINE_RE.exec('![](/api/v1/assets/abc.png)')
    expect(m).not.toBeNull()
  })

  test('含其它文本则不匹配', () => {
    expect(IMAGE_LINE_RE.exec('text ![alt](a.png) more')).toBeNull()
    expect(IMAGE_LINE_RE.exec('![alt](a.png)\nnext')).toBeNull()
  })

  test('URL 含空格被解析为带标题（GFM 规则）', () => {
    const m = IMAGE_LINE_RE.exec('![alt](https://a.png "x y")')
    expect(m).not.toBeNull()
    expect(m?.[2]).toBe('https://a.png')
  })
})
