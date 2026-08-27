/**
 * docx → Markdown。mammoth 官方已弃用 convertToMarkdown（标题书签会写成
 * `<a id="..."></a>`），走 convertToHtml 再转 MD。
 */

import mammoth from 'mammoth'
import { htmlToMarkdown } from '../lib/htmlToMarkdown'
import { saveImportedImage } from './importedImage'

export class DocxConvertError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocxConvertError'
  }
}

/** 中文 Word / WPS 内置标题样式（默认 style map 只认 Heading 1） */
const CJK_HEADING_STYLE_MAP = [
  "p[style-name='标题 1'] => h1:fresh",
  "p[style-name='标题 2'] => h2:fresh",
  "p[style-name='标题 3'] => h3:fresh",
  "p[style-name='标题 4'] => h4:fresh",
  "p[style-name='标题 5'] => h5:fresh",
  "p[style-name='标题 6'] => h6:fresh",
  "p[style-name='标题1'] => h1:fresh",
  "p[style-name='标题2'] => h2:fresh",
  "p[style-name='标题3'] => h3:fresh",
]

export interface DocxConvertResult {
  markdown: string
  mediaImported: number
}

export async function convertDocxToMarkdown(buffer: Buffer): Promise<DocxConvertResult> {
  let mediaImported = 0
  const convertImage = mammoth.images.imgElement(async (image) => {
    const data = await image.readAsBuffer()
    const src = saveImportedImage(data, image.contentType || '')
    if (!src) return { src: '' }
    mediaImported++
    return { src }
  })

  let html: string
  try {
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        convertImage,
        ignoreEmptyParagraphs: true,
        styleMap: CJK_HEADING_STYLE_MAP,
      },
    )
    html = result.value
  } catch (e) {
    throw new DocxConvertError(e instanceof Error ? e.message : String(e))
  }

  const markdown = htmlToMarkdown(html)
  if (!markdown.trim()) {
    throw new DocxConvertError('docx 未提取到文本内容')
  }
  return { markdown, mediaImported }
}
