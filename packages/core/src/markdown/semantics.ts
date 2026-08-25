/**
 * Markdown → blocks 的语义形状（忽略每次保存都变的 id）。
 *
 * corpus 与新旧 parser 对照共用：只比较 type / content / properties / 父子关系。
 */

import type { Block, CreateBlockInput } from '../types'
import { inputsToBlockTree } from '../model'

/** 去掉 id 后的 block 树，供 snapshot 与等价比较 */
export interface SemanticNode {
  type: string
  content: string
  properties: Record<string, unknown>
  children: SemanticNode[]
}

/** 规范化 properties：排序 key、去掉 undefined，避免 JSON 顺序误伤 */
export function canonProperties(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const src = props ?? {}
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src).sort()) {
    const value = src[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * 扁平 CreateBlockInput（parse 产出）→ 语义森林。
 * 按输入顺序建树；parent 尚未出现或为空则视为根。
 */
export function toSemanticForest(inputs: CreateBlockInput[]): SemanticNode[] {
  type Node = SemanticNode & { id: string }
  const nodes = new Map<string, Node>()
  const forest: Node[] = []

  for (const input of inputs) {
    const id = input.id
    if (!id) {
      throw new Error('toSemanticForest: parse 结果缺少 block id')
    }
    const node: Node = {
      id,
      type: input.type,
      content: input.content ?? '',
      properties: canonProperties(input.properties),
      children: [],
    }
    nodes.set(id, node)
    const parentId = input.parent_id ?? null
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else forest.push(node)
  }

  return forest.map(stripId)
}

function stripId(node: SemanticNode): SemanticNode {
  return {
    type: node.type,
    content: node.content,
    properties: canonProperties(node.properties),
    children: node.children.map(stripId),
  }
}

/** 语义等价：JSON 规范化后比较 */
export function semanticEqual(a: SemanticNode[], b: SemanticNode[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 给 parse 产出补上文档序 sort，再建树，供 blocksToMarkdown round-trip。
 * parseMarkdownToBlocks 目前把 sort 全写成 0，不补序的话子块顺序不稳定。
 */
export function inputsToOrderedBlocks(inputs: CreateBlockInput[]): Block[] {
  return inputsToBlockTree(inputs.map((input, index) => ({ ...input, sort: index })))
}
