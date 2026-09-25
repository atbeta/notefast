/**
 * 投影出方向的写回编排（RFC 0007 D4/D5）。
 *
 * 把已经实现的零件接起来：
 *   1. 读磁盘（可选做乐观并发校验）
 *   2. 能局部改写就局部改写（`patch.ts`），否则整篇序列化
 *   3. 原子写（`writer.ts`）
 *   4. 刷新映射指纹（让随后到来的 watcher 事件在 sha 短路处被吞掉）
 *
 * 冲突裁决：**库赢**。磁盘在我们之后被外部改过时，库里的版本照写，
 * 外部版本由调用方落成冲突副本（`conflict.ts`）。
 */

import { existsSync, readFileSync } from 'node:fs'
import type { BlockRow } from '@notefast/core'
import { blocksToMarkdown, patchFrontmatter, readTags, stripDocFrontmatter, type Block } from '@notefast/core'
import type { getDb } from '../db'
import { patchProjectionBody } from './patch'
import { blockSubtreeHash, topLevelBlocks } from './spans'
import {
  listProjectionBlockSpans,
  replaceProjectionBlockSpans,
} from '../store/projectionSpans'
import { touchProjectionFileAfterWrite } from '../store/projectionFiles'
import { sha256Hex, writeProjectionFileAtomic } from './writer'
import { toProjectionAbsPath } from './paths'
import { portableDocMarkdown } from '../services/portableMarkdown'
import { auditProjection, PROJECTION_AUDIT } from './audit'
import { writeConflictCopy } from './conflict'
import { materializeAssets } from './assets'
import type { ProjectionConfig } from './config'
import type { SerialLock } from './lock'

type Db = ReturnType<typeof getDb>

export interface WritebackContext {
  db: Db
  notebookId: string
  config: ProjectionConfig
  lock: SerialLock
}

export type WritebackOutcome =
  | { kind: 'written'; mode: 'patch' | 'full'; contentSha256: string }
  | { kind: 'conflict'; conflictRelPath: string | null; expectedSha: string | null; actualSha: string | null }
  | { kind: 'skipped'; reason: 'no-mapping' | 'unchanged' | 'disabled' }

export interface WritebackDocInput {
  doc: BlockRow
  relPath: string
  /** 上次记录的 sha；undefined = 不做并发校验 */
  expectedSha?: string | null
  /** content = 库侧内容（写进文件 / 冲突副本）；磁盘现状不会被抄走 */
  content: string
}

/** 磁盘现状与「库版本」是否一致（一致则无需写入） */
function sameContent(disk: string | null, content: string): boolean {
  return disk !== null && sha256Hex(disk) === sha256Hex(content)
}

/**
 * 写一篇文档到投影文件。
 *
 * `expectedSha` 传入时先核对磁盘：不等 = 外部改过 → 落冲突副本后仍写库版本（D5 裁决）。
 */
export async function writeProjectionDoc(
  ctx: WritebackContext,
  input: WritebackDocInput,
): Promise<WritebackOutcome> {
  const { config } = ctx
  const abs = toProjectionAbsPath(config.root, input.relPath)
  const disk = existsSync(abs) ? readFileSync(abs, 'utf-8') : null

  if (sameContent(disk, input.content)) {
    return { kind: 'skipped', reason: 'unchanged' }
  }

  // 乐观并发：磁盘不是我们上次见到的版本 → 外部工具改过
  if (input.expectedSha !== undefined && disk !== null) {
    const actual = sha256Hex(disk)
    if (input.expectedSha !== null && actual !== input.expectedSha) {
      const copy = await writeConflictCopy(config.root, abs, input.content)
      auditProjection(
        PROJECTION_AUDIT.conflict,
        input.doc.id,
        {
          rel_path: input.relPath,
          expected_sha: input.expectedSha,
          actual_sha: actual,
          conflict_path: copy.relPath,
        },
        'failure',
      )
      // 库赢：继续写下去，外层决定是否把副本路径报给用户
      const written = await writeProjectionFileAtomic(abs, input.content)
      refreshAfterWrite(ctx, input.doc, written.sha256, written.size, written.mtimeMs)
      return {
        kind: 'conflict',
        conflictRelPath: copy.relPath,
        expectedSha: input.expectedSha,
        actualSha: actual,
      }
    }
  }

  const written = await writeProjectionFileAtomic(abs, input.content)
  refreshAfterWrite(ctx, input.doc, written.sha256, written.size, written.mtimeMs)
  return { kind: 'written', mode: 'full', contentSha256: written.sha256 }
}

/**
 * 写回成功后刷新映射指纹（同步）。
 *
 * 这一步是回声抑制的**全部实现**：刷新之后，watcher 因为这次写入收到的事件
 * 会在 ingest 的 sha 短路处命中 `unchanged`，不需要额外的「正在写」标记。
 */
function refreshAfterWrite(
  ctx: WritebackContext,
  doc: BlockRow,
  contentSha256: string,
  size: number,
  mtimeMs: number,
): void {
  const current = ctx.db.query('SELECT updated_at FROM blocks WHERE id = ?').get(doc.id) as
    | { updated_at: string }
    | undefined
  touchProjectionFileAfterWrite(
    ctx.db,
    ctx.notebookId,
    doc.id,
    contentSha256,
    size,
    mtimeMs,
    current?.updated_at ?? doc.updated_at,
  )
}

/**
 * 渲染一篇文档的投影内容，优先局部改写。
 *
 * 返回的 `mode` 用于审计：`full` 表示拿不到区间记录或区间校验失败，
 * 这次是整篇重新序列化（会归一化用户的排版）。
 */
export function renderProjectionContent(
  db: Db,
  doc: BlockRow,
  diskContent: string | null,
  opts: { relPath?: string; config?: ProjectionConfig } = {},
): { content: string; mode: 'patch' | 'full' } {
  const materialize = (markdown: string): string =>
    opts.relPath && opts.config ? materializeAssets(markdown, opts.relPath, opts.config).markdown : markdown

  const full = materialize(renderFull(doc))
  if (diskContent === null) return { content: full, mode: 'full' }

  const oldSpans = listProjectionBlockSpans(db, doc.id)
  if (oldSpans.length === 0) return { content: full, mode: 'full' }

  const stripped = stripDocFrontmatter(diskContent)
  // 偏移口径与 ingest 完全一致：**只剥 frontmatter，不剥标题行**。
  // 库里那行 H1 是一个真实的 heading 块（当它与文件名不同时尤其明显），
  // 所以它必须参与对齐；把标题行摘出去会让块数与区间对不上，区间表整体失效。
  //
  // 标题行的「改名」由**块本身**承载：它在库里是 heading 块，改了名就作为普通块
  // 被 patch 重写，不需要在这里特判（早先特判过，结果是文件里出现两个 H1）。
  const oldBody = stripped.body
  const tops = topLevelBlocks(db, doc.id)
  const blocks = tops.map((b) => ({ id: b.id, hash: blockSubtreeHash(b), text: blocksToMarkdown([b as Block]) }))
  const patched = patchProjectionBody({ oldBody, oldSpans, blocks })
  if (!patched) return { content: full, mode: 'full' }

  replaceProjectionBlockSpans(db, doc.id, patched.spans)
  // 首行 `# 标题` 落在 patch 结果的头部缝隙里，不在任何块区间内。
  // 库里改了标题必须在这里替换它，否则文件标题永远停在旧值（实测踩过）。
  return {
    content: materialize(withFrontmatter(stripped.raw, replaceRootHeading(patched.body, doc, db), doc)),
    mode: 'patch',
  }
}

/**
 * 整篇序列化。
 *
 * 直接复用 `portableDocMarkdown`：它已经处理了「取块树 + 序列化 + frontmatter」
 * （`buildBlockTree(fetchDocBlocks(...))`）。自己拼一个 `blocksToMarkdown([doc])`
 * 只会得到 `# 标题`——文档根没有 children，正文全丢（实测踩过）。
 */
function renderFull(doc: BlockRow): string {
  return portableDocMarkdown(doc)
}

/**
 * 磁盘正文首行是不是「文档根标题」那一行。
 *
 * 这一行由 `blocksToMarkdown` 对 document 根输出，**不对应任何块**，
 * 所以它既不参与区间对齐（见 spans.ts），也不在任何块区间里。
 * 判断只看「是不是首行 H1」，不看内容是否等于当前标题——改名时内容会变，
 * 但「有没有这一行」不变。
 */
/**
 * 正文首行是不是「文档根标题」那一行（库里**没有**对应块的那一行）。
 *
 * 判据是「首行是 H1 **且** 库里的首个顶层块不是同内容的 heading」——
 * **不能**用「首行 H1 与当前标题同文」：渲染侧手里是**磁盘旧内容 + 当前标题**，
 * 一旦在库里改了名，两者必然不同，判据就会失效、文件标题永远停在旧值（实测踩过）。
 *
 * 为什么要区分：用户完全可以自己写一个与标题不同的 H1（`# 旧名`，标题是文件名）。
 * 那一行在库里有对应的 heading 块，是**用户内容**，必须原样往返，不能被覆盖。
 *
 * 与 `spans.ts` 的判据等价（那边是解析结果与库里逐块比对，同一次快照，天然自洽）。
 */
function isRootHeadingLine(body: string, db: Db, docId: string): boolean {
  if (!body) return false
  const nl = body.indexOf('\n')
  const firstLine = (nl < 0 ? body : body.slice(0, nl)).trim()
  if (!/^#\s+\S/.test(firstLine)) return false
  const firstBlock = topLevelBlocks(db, docId)[0]
  if (!firstBlock || firstBlock.type !== 'heading') return true
  const headingText = firstLine.replace(/^#\s*/, '').trim()
  return (firstBlock.content ?? '').trim() !== headingText
}

/**
 * 把正文首行的「文档根标题」替换为当前标题（不改变后续偏移）。
 * 只在首行确实是根标题时替换；用户自己写的别的 H1 不动。
 */
function replaceRootHeading(body: string, doc: BlockRow, db: Db): string {
  if (!isRootHeadingLine(body, db, doc.id)) return body
  const nl = body.indexOf('\n')
  const rest = nl < 0 ? '' : body.slice(nl + 1)
  return titleHeadingOf(doc) + rest
}

function titleHeadingOf(doc: BlockRow): string {
  const title = (doc.content || '').trim()
  return title ? `# ${title}\n` : ''
}

/** 保留磁盘上的 frontmatter（用户手写字段逐字节不动），只把 tags 投影进去 */
function withFrontmatter(raw: string | null, body: string, doc: BlockRow): string {
  const tags = readTags(doc)
  const frontmatterRaw =
    tags.length === 0 && raw === null ? null : patchFrontmatter(raw, tags.length === 0 ? {} : { tags })
  const fm = frontmatterRaw ? `---\n${frontmatterRaw}\n---\n` : ''
  return fm + body
}
