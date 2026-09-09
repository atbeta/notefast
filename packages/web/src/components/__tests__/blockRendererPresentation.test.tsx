/**
 * BlockRenderer presentation（公开展示）模式契约
 *
 * 分享页匿名面：隐藏一切应用内交互件（块菜单 handle、上传徽章），
 * asset: 图片经注入的 assetUrl 解析（公开端点），不碰鉴权 API。
 * 用 react-dom/server 渲染（无 DOM 依赖；AssetSync 等 effect 不执行）。
 */
import { describe, test, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import BlockRenderer from '../BlockRenderer'
import { ToastProvider } from '../ui'
import { VaultDocProvider } from '../VaultDocContext'
import { BlockType, type Block } from '@notefast/core'

let sort = 0
function leaf(type: BlockType, content: string, properties: Record<string, unknown> = {}): Block {
  return {
    id: `b${++sort}`, notebook_id: 'nb', parent_id: 'doc', root_id: 'doc',
    type, content, properties, tags: [], status: 'note', ai_exclude: false,
    sort, level: 1, created_at: '', updated_at: '', children: [],
  }
}

function doc(children: Block[]): Block {
  return {
    id: 'doc', notebook_id: 'nb', parent_id: null, root_id: 'doc',
    type: BlockType.Document, content: '标题', properties: {}, tags: [], status: 'note',
    ai_exclude: false, sort: 0, level: 0, created_at: '', updated_at: '', children,
  }
}

const SHA = 'a'.repeat(64)

describe('BlockRenderer presentation 模式', () => {
  const tree = doc([
    leaf(BlockType.Paragraph, '第一行\n第二行'),
    leaf(BlockType.Paragraph, `![图](asset:${SHA})`),
  ])

  test('presentation：软换行 <br>、asset 走注入 URL、无应用内交互件', () => {
    const html = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: tree,
        presentation: true,
        assetUrl: (sha) => `/share/tok/assets/${sha}`,
      }),
    )
    // 软换行（与登录后阅读态一致）
    expect(html).toContain('<br')
    // asset 经公开端点解析，不碰鉴权 API
    expect(html).toContain(`/share/tok/assets/${SHA}`)
    expect(html).not.toContain('/api/v1/assets/')
    // 无块菜单 handle（aria-label 只在 BlockHandle 按钮上出现）
    expect(html).not.toContain('block.menuLabel')
    // 无图床上传/同步徽章
    expect(html).not.toContain('block.assetLocal')
    expect(html).not.toContain('block.assetSynced')
  })

  test('非 presentation（登录后阅读态）：asset 走鉴权 API，有 handle', () => {
    // BlockHandle 依赖 ToastProvider（复制链接的反馈）
    const html = renderToStaticMarkup(
      createElement(ToastProvider, null, createElement(BlockRenderer, { block: tree })),
    )
    expect(html).toContain(`/api/v1/assets/${SHA}`)
    expect(html).not.toContain('/share/tok/assets/')
  })
})

describe('BlockRenderer vault 图片（V-303）', () => {
  function render(block: Block, vaultPath: string | null) {
    return renderToStaticMarkup(
      <VaultDocProvider vaultPath={vaultPath}>
        <ToastProvider>
          <BlockRenderer block={block} />
        </ToastProvider>
      </VaultDocProvider>,
    )
  }

  test('vault 文档：相对路径按来源文件所在目录解析为 raw API', () => {
    const html = render(leaf(BlockType.Paragraph, '![图](assets/x.png)'), 'notes/sub/doc.md')
    expect(html).toContain('/api/v1/vault/raw/notes/sub/assets/x.png')
  })

  test('db notebook（无 Provider）：相对路径原样，不接管', () => {
    const html = render(leaf(BlockType.Paragraph, '![图](assets/x.png)'), null)
    expect(html).toContain('src="assets/x.png"')
    expect(html).not.toContain('/api/v1/vault/raw/')
  })

  test('asset: 引用不受 vault 影响', () => {
    const html = render(leaf(BlockType.Paragraph, `![图](asset:${SHA})`), 'doc.md')
    expect(html).toContain(`/api/v1/assets/${SHA}`)
    expect(html).not.toContain('/api/v1/vault/raw/')
  })

  test('![[x.png]]：vault 文档渲染为图片，非资源嵌入保留原文', () => {
    const vault = render(leaf(BlockType.Paragraph, '![[x.png]] 与 ![[某篇笔记]]'), 'doc.md')
    expect(vault).toContain('/api/v1/vault/raw/x.png')
    expect(vault).toContain('![[某篇笔记]]')
    expect(vault).not.toContain('![[x.png]]')

    const plain = render(leaf(BlockType.Paragraph, '![[x.png]]'), null)
    expect(plain).toContain('![[x.png]]')
    expect(plain).not.toContain('/api/v1/vault/raw/')
  })
})

describe('BlockRenderer 表格 \\| 转义', () => {
  test('单元格内 \\| 不增列，阅读态与 GFM 一致', () => {
    const content = [
      '| prop | 类型 | 默认 |',
      '| --- | --- | --- |',
      '| `minSize` | `number \\| string` | `0` |',
    ].join('\n')
    const html = renderToStaticMarkup(
      createElement(BlockRenderer, {
        block: doc([leaf(BlockType.Table, content)]),
        presentation: true,
      }),
    )
    // 4 列表头（含闭合）→ 一行 3 个 th；体行 3 个 td，不被 \| 拆成 4+
    expect(html.match(/<th\b/g)?.length).toBe(3)
    expect(html.match(/<td\b/g)?.length).toBe(3)
    expect(html).toContain('number | string')
    expect(html).not.toContain('number \\')
  })
})
