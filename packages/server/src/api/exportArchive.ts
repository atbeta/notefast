/**
 * 整库导出：自包含 zip（<slug>--<docId>.md + media/ + manifest），
 * 与 Markdown 归档同构，可被自家导入器精确还原。
 */

import { Hono } from 'hono'
import { buildFullArchiveExport, contentDispositionAttachment } from '../services/docExport'

const exportArchive = new Hono()

exportArchive.get('/archive', () => {
  const file = buildFullArchiveExport()
  return new Response(Buffer.from(file.body), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDispositionAttachment(file.filename),
      'Cache-Control': 'no-store',
    },
  })
})

export default exportArchive
