/**
 * vault 文件 ingest：parse → align → apply
 *
 * @see docs/rfcs/0002-block-identity.md §"增量 ingest 流程"
 *
 * MVP 阶段简化：
 *   - 不直接操作 SQLite（避免 schema 复杂度）
 *   - 通过现有 import/markdown 端点的 source 字段做去重
 *   - block ID 稳定性交给 main v0.86 的 blockAlign 在 save 路径上保证
 *
 * 后续阶段：
 *   - 直接读 SQLite，复用 planBlockAlign 对齐
 *   - 支持 wiki-link 解析 + block_refs 建链
 *   - 支持 image / asset 关联
 */

import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { buildHeadingPathMap, vaultFingerprint, type BlockForId } from './identity'
import type { VaultConfig } from './config'

export interface IngestStats {
  filePath: string
  kept: number
  inserted: number
  updated: number
  deleted: number
  fingerprints: string[]
  durationMs: number
}

interface ParsedBlock {
  type: 'heading' | 'paragraph' | 'code' | 'list' | 'other'
  content: string
  startLine: number
  headingLevel?: number
  headingText?: string
}

/**
 * 解析一个 .md 文件，提取所有块的 vault fingerprint
 *
 * 这是一个纯函数，不写数据库——便于测试和 PoC 验证
 */
export async function computeFileFingerprints(
  filePath: string,
  config: VaultConfig,
): Promise<{ relPath: string; fingerprints: Array<{ line: number; fp: string }>; durationMs: number }> {
  const start = Date.now()
  const content = await readFile(filePath, 'utf8')
  const relPath = relative(config.path, filePath)
  const lines = content.split('\n')

  const blocks = parseMarkdownLines(lines)
  const headingStarts = blocks
    .filter((b): b is ParsedBlock & { headingLevel: number; headingText: string } =>
      b.type === 'heading',
    )
    .map((b) => ({ line: b.startLine, depth: b.headingLevel, text: b.headingText }))

  const headingPathMap = buildHeadingPathMap(lines, headingStarts)

  const fingerprints: Array<{ line: number; fp: string }> = []
  for (const block of blocks) {
    if (block.type === 'heading') continue
    const blockForId: BlockForId = {
      content: block.content,
      line: block.startLine,
      type: block.type,
    }
    const fp = vaultFingerprint(blockForId, {
      filePath: relPath,
      lines,
      headingPath: headingPathMap.get(block.startLine) ?? '',
    })
    fingerprints.push({ line: block.startLine, fp })
  }

  return {
    relPath,
    fingerprints,
    durationMs: Date.now() - start,
  }
}

/**
 * 主入口：处理一个文件变更
 *
 * MVP 阶段：只算 fingerprints 并打印，不写 SQLite
 * 后续阶段：调 store/blocks.ts 应用 diff
 */
export async function ingestFile(filePath: string, config: VaultConfig): Promise<IngestStats> {
  const start = Date.now()
  const { relPath, fingerprints } = await computeFileFingerprints(filePath, config)

  return {
    filePath: relPath,
    kept: 0, // TODO: compare with existing blocks in SQLite
    inserted: fingerprints.length,
    updated: 0,
    deleted: 0,
    fingerprints: fingerprints.map((f) => f.fp),
    durationMs: Date.now() - start,
  }
}

/**
 * 全量重建 vault 索引
 *
 * 性能目标（RFC 0002 验证标准）：
 *   - 1000 文件 vault 首次全量索引 < 60s
 */
export async function rebuildVaultIndex(
  config: VaultConfig,
): Promise<{ totalFiles: number; totalBlocks: number; durationMs: number }> {
  const start = Date.now()
  const { readdir } = await import('node:fs/promises')
  const files: string[] = []

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`
      const rel = relative(config.path, full)
      if (config.ignore.some((p) => rel.startsWith(p))) continue
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name.endsWith('.md')) {
        files.push(full)
      }
    }
  }

  await walk(config.path)

  let totalBlocks = 0
  for (const file of files) {
    const { fingerprints } = await computeFileFingerprints(file, config)
    totalBlocks += fingerprints.length
  }

  return {
    totalFiles: files.length,
    totalBlocks,
    durationMs: Date.now() - start,
  }
}

// --- 行级 Markdown 解析（PoC 简化版） ---

/**
 * 极简行级 Markdown 解析：识别 heading / paragraph / code / list
 *
 * 不做完整 CommonMark 解析——只识别结构边界，用于 fingerprint 计算。
 * 完整 mdast 解析留给 save 路径上的 parseMarkdownToBlocks。
 */
function parseMarkdownLines(lines: string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  let inCodeFence = false
  let fenceStartLine = 0
  let buffer: string[] = []
  let bufferStartLine = 0

  const flushParagraph = () => {
    if (buffer.length === 0) return
    blocks.push({
      type: 'paragraph',
      content: buffer.join('\n').trim(),
      startLine: bufferStartLine,
    })
    buffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    // 代码围栏
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (!inCodeFence) {
        flushParagraph()
        inCodeFence = true
        fenceStartLine = i
        buffer = [line]
      } else {
        buffer.push(line)
        blocks.push({
          type: 'code',
          content: buffer.join('\n'),
          startLine: fenceStartLine,
        })
        buffer = []
        inCodeFence = false
      }
      continue
    }

    if (inCodeFence) {
      buffer.push(line)
      continue
    }

    // heading
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      flushParagraph()
      blocks.push({
        type: 'heading',
        content: headingMatch[2] ?? '',
        startLine: i,
        headingLevel: headingMatch[1]?.length ?? 1,
        headingText: headingMatch[2] ?? '',
      })
      continue
    }

    // 列表
    if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      if (buffer.length === 0) bufferStartLine = i
      buffer.push(line)
      continue
    }

    // 空行：段落分隔
    if (trimmed === '') {
      flushParagraph()
      continue
    }

    // 普通文本
    if (buffer.length === 0) bufferStartLine = i
    buffer.push(line)
  }

  flushParagraph()
  return blocks
}
