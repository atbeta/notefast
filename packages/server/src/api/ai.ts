import { Hono } from 'hono'
import { getAiConfig, indexBlock, indexAllBlocks } from '../ai/indexer'
import { semanticSearch } from '../ai/vector'

const ai = new Hono()

ai.get('/status', (c) => {
  const config = getAiConfig()
  return c.json({
    enabled: config.enabled,
    provider: config.provider?.name || 'none',
  })
})

ai.get('/search', (c) => {
  const config = getAiConfig()
  if (!config.enabled || !config.provider) {
    return c.json({ error: 'not_configured', message: '未配置 Embedding Provider，请设置 EMBEDDING_API_KEY' }, 400)
  }

  const q = c.req.query('q') || ''
  const limit = parseInt(c.req.query('limit') || '10', 10)
  const notebookId = c.req.query('notebook_id') || undefined

  if (!q.trim()) {
    return c.json([])
  }

  return config.provider.embedQuery(q.trim()).then((vector) => {
    const hits = semanticSearch(vector, Math.min(limit, 20), notebookId)
    return c.json(hits)
  }).catch((e) => {
    return c.json({ error: 'embedding_error', message: String(e) }, 500)
  })
})

ai.post('/index', async (c) => {
  const config = getAiConfig()
  if (!config.enabled || !config.provider) {
    return c.json({ error: 'not_configured', message: '未配置 Embedding Provider' }, 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const notebookId: string | undefined = body.notebook_id

  try {
    const result = await indexAllBlocks(notebookId)
    return c.json(result)
  } catch (e) {
    return c.json({ error: 'index_error', message: String(e) }, 500)
  }
})

ai.post('/index/:blockId', async (c) => {
  const blockId = c.req.param('blockId')
  const config = getAiConfig()
  if (!config.enabled || !config.provider) {
    return c.json({ error: 'not_configured' }, 400)
  }

  try {
    await indexBlock(blockId)
    return c.json({ indexed: true })
  } catch (e) {
    return c.json({ error: 'index_error', message: String(e) }, 500)
  }
})

export default ai
