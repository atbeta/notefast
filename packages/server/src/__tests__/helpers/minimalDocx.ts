/** 测试用最小 docx（真实 OOXML，供 mammoth 解析） */

export async function makeMinimalDocx(opts: {
  heading?: string
  body?: string
  /** 标题上的 Word 书签（目录 TOC 会写 _Toc…，mammoth markdown 会泄漏成 <a id>） */
  headingBookmark?: string
  headingStyleId?: string
} = {}): Promise<Uint8Array> {
  const heading = opts.heading ?? 'Word 标题'
  const body = opts.body ?? 'Word 正文内容'
  const styleId = opts.headingStyleId ?? 'Heading1'
  const bookmark = opts.headingBookmark
  const headingInner = bookmark
    ? `<w:bookmarkStart w:id="0" w:name="${escXml(bookmark)}"/><w:r><w:t>${escXml(heading)}</w:t></w:r><w:bookmarkEnd w:id="0"/>`
    : `<w:r><w:t>${escXml(heading)}</w:t></w:r>`

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="${escXml(styleId)}"/></w:pPr>${headingInner}</w:p>
    <w:p><w:r><w:t>${escXml(body)}</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`)
  return zip.generateAsync({ type: 'uint8array' })
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
