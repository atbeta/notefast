import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * useFileOpenEvents 队列状态机：
 * - pushPreviewItem：入队（FIFO），超 MAX_CONTENT_CHARS 拒收
 * - previewNext / previewPrev：边界保护（首/末不能继续）
 * - discardCurrentPreview：丢当前，下一项顶上；末尾时退回上一项
 * - discardAllPreviews：清空
 * - __resetPreviewQueueForTests：每个 case 前重置（模块态跨文件残留见 AGENTS.md）
 */

beforeEach(async () => {
  const { __resetPreviewQueueForTests } = await import('../useFileOpenEvents')
  __resetPreviewQueueForTests()
})

const sampleItem = (title: string) => ({
  title,
  content: `# ${title}\n\nbody`,
  path: `/path/${title}.md`,
  contentHash: 'deadbeef',
})

describe('pushPreviewItem', () => {
  test('入队 FIFO 并暴露给 getSnapshot', async () => {
    const { pushPreviewItem, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    pushPreviewItem(sampleItem('a'))
    pushPreviewItem(sampleItem('b'))
    pushPreviewItem(sampleItem('c'))
    const s = getPreviewQueueSnapshot()
    expect(s.items.map((i) => i.title)).toEqual(['a', 'b', 'c'])
  })

  test('非字符串 content 拒收（shell 拼错 detail 时的兜底）', async () => {
    const { pushPreviewItem, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    // @ts-expect-error 故意传入非法值
    expect(pushPreviewItem({ title: 'x', content: 123, path: '', contentHash: '' })).toBe(false)
    expect(getPreviewQueueSnapshot().items).toHaveLength(0)
  })

  test('超 MAX_CONTENT_CHARS 拒收（与 importMarkdownSchema 上限对齐，护 web 内存）', async () => {
    const { pushPreviewItem, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    const huge = 'x'.repeat(5_000_001)
    expect(pushPreviewItem({ title: 'huge', content: huge, path: '', contentHash: '' })).toBe(false)
    expect(getPreviewQueueSnapshot().items).toHaveLength(0)
  })
})

describe('previewNext / previewPrev（边界保护）', () => {
  test('空队列 next/prev 均不动', async () => {
    const { previewNext, previewPrev, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    previewNext()
    previewPrev()
    expect(getPreviewQueueSnapshot().currentIndex).toBe(0)
  })

  test('单文件 next/prev 均不动', async () => {
    const { pushPreviewItem, previewNext, previewPrev, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    pushPreviewItem(sampleItem('only'))
    previewNext()
    previewPrev()
    expect(getPreviewQueueSnapshot().currentIndex).toBe(0)
  })

  test('next 抵达末尾即停', async () => {
    const { pushPreviewItem, previewNext, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    pushPreviewItem(sampleItem('a'))
    pushPreviewItem(sampleItem('b'))
    previewNext() // 0→1
    previewNext() // 1→1（末尾）
    expect(getPreviewQueueSnapshot().currentIndex).toBe(1)
  })

  test('prev 不能退到 -1', async () => {
    const { pushPreviewItem, previewPrev, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    pushPreviewItem(sampleItem('a'))
    pushPreviewItem(sampleItem('b'))
    previewPrev() // 0→0（首）
    expect(getPreviewQueueSnapshot().currentIndex).toBe(0)
  })
})

describe('discardCurrentPreview', () => {
  test('丢中间项 → 下一项顶上（索引不变）', async () => {
    const { pushPreviewItem, discardCurrentPreview, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    pushPreviewItem(sampleItem('a'))
    pushPreviewItem(sampleItem('b'))
    pushPreviewItem(sampleItem('c'))
    // currentIndex=0（看 a）
    discardCurrentPreview()
    const s = getPreviewQueueSnapshot()
    expect(s.items.map((i) => i.title)).toEqual(['b', 'c'])
    expect(s.currentIndex).toBe(0) // 现在看 b
  })

  test('丢最后一项 → 退回上一项', async () => {
    const { pushPreviewItem, previewNext, discardCurrentPreview, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    pushPreviewItem(sampleItem('a'))
    pushPreviewItem(sampleItem('b'))
    pushPreviewItem(sampleItem('c'))
    previewNext() // 0→1
    previewNext() // 1→2（看 c）
    discardCurrentPreview() // 丢 c → 退回 b
    const s = getPreviewQueueSnapshot()
    expect(s.items.map((i) => i.title)).toEqual(['a', 'b'])
    expect(s.currentIndex).toBe(1) // 看 b
  })

  test('空队列 discardCurrentPreview 是 no-op', async () => {
    const { discardCurrentPreview, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    discardCurrentPreview()
    expect(getPreviewQueueSnapshot().items).toHaveLength(0)
  })
})

describe('discardAllPreviews', () => {
  test('清空队列与索引', async () => {
    const { pushPreviewItem, discardAllPreviews, getPreviewQueueSnapshot } = await import('../useFileOpenEvents')
    pushPreviewItem(sampleItem('a'))
    pushPreviewItem(sampleItem('b'))
    discardAllPreviews()
    const s = getPreviewQueueSnapshot()
    expect(s.items).toHaveLength(0)
    expect(s.currentIndex).toBe(0)
  })
})

describe('sessionStorage 持久化（壳层 dispatch→整页跳 /preview 的恢复面）', () => {
  test('serialize → parse 往返保真（含 currentIndex）', async () => {
    const { serializePreviewQueue, parsePersistedQueue } = await import('../useFileOpenEvents')
    const s = { items: [sampleItem('a'), sampleItem('b')], currentIndex: 1 }
    const restored = parsePersistedQueue(serializePreviewQueue(s))
    expect(restored).toEqual(s)
  })

  test('null / 非法 JSON / 非数组 items → null（按空队列处理）', async () => {
    const { parsePersistedQueue } = await import('../useFileOpenEvents')
    expect(parsePersistedQueue(null)).toBeNull()
    expect(parsePersistedQueue('not json')).toBeNull()
    expect(parsePersistedQueue('{"items":{}}')).toBeNull()
    expect(parsePersistedQueue('{"items":[{"content":123}]}')).toBeNull()
  })

  test('超 MAX_CONTENT_CHARS 的持久化项拒收（与 push 口径一致）', async () => {
    const { serializePreviewQueue, parsePersistedQueue } = await import('../useFileOpenEvents')
    const huge = { title: 'h', content: 'x'.repeat(5_000_001), path: '', contentHash: '' }
    expect(parsePersistedQueue(serializePreviewQueue({ items: [huge], currentIndex: 0 }))).toBeNull()
  })

  test('缺省字段补空串；currentIndex 越界回收到末项', async () => {
    const { parsePersistedQueue } = await import('../useFileOpenEvents')
    const raw = JSON.stringify({ items: [{ content: 'body' }], currentIndex: 7 })
    expect(parsePersistedQueue(raw)).toEqual({
      items: [{ title: '', content: 'body', path: '', contentHash: '' }],
      currentIndex: 0,
    })
  })
})