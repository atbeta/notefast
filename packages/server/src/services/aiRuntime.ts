/**
 * AI Runtime 初始化
 *
 * 启动流程：
 * 1. 检查 data/ai.config.json；若不存在则用环境变量作为种子
 * 2. 构造 AiRuntime 单例，挂上 plugin hooks（afterCreate/Update/Delete → 自动索引 + 自动链接）
 * 3. 把 runtime 暴露给 api/ai、mcp/tools
 *
 * 热重载流程（PUT /api/v1/ai/config）：
 * 1. 持久化新配置到 json
 * 2. 卸载旧 plugin hooks（ai-indexer / ai-linker）
 * 3. runtime.reload(cfg)
 * 4. 根据新 cfg 重新挂载 hooks
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import {
  AiRuntime,
  configFromEnv,
  emptyConfig,
  type AiConfig,
  type Block,
} from '@notefast/core'
import type { PluginSystem } from '@notefast/core'
import { getDb } from '../db'
import { fetchDocBlocks, getDocById } from '../store/blocks'
import { deleteRefsFromSource } from '../store/refs'
import { deleteMentionsFromSource } from '../store/entities'
import { indexBlock, deleteVector } from '../ai/indexer'
import { getLatestIndexJobForDoc, scheduleDocIndex } from '../ai/indexJobs'
import { analyzeBlock } from '../ai/autoLink'
import {
  embeddingFingerprint,
  markVectorStoreStaleIfModelChanged,
} from '../ai/vectorStore'
import { isBlockAiExcluded } from '../ai/aiExcludeQuery'

const CONFIG_FILE = 'ai.config.json'
const HOOK_NAME = 'ai-indexer'
const AUTOLINK_HOOK_NAME = 'ai-linker'

let runtime: AiRuntime | null = null
let dataDir = ''
let pluginSystem: PluginSystem | null = null

/** 启动期初始化（index.ts 调用） */
export function initAiRuntime(sys: PluginSystem, dir: string): AiRuntime {
  dataDir = dir
  pluginSystem = sys
  const path = join(dir, CONFIG_FILE)
  const fromEnv = configFromEnv(process.env)
  if (fromEnv.chat || fromEnv.embedding || fromEnv.reranker) {
    console.log(`🧠 AI: 环境变量已设 — ${fromEnv.chat?.chatModel || '(无 chat)'} / ${fromEnv.embedding?.embeddingModel || '(无 embedding)'}`)
  }
  const initial = loadOrSeed()
  if (initial.chat || initial.embedding) {
    const src = existsSync(path) ? path : '<env>'
    console.log(`🧠 AI: 加载配置自 ${src}`)
  }
  const r = new AiRuntime(initial)
  runtime = r
  applyAutoIndex(r, sys)
  applyAutoLink(r, sys)
  return r
}

/** 测试用：注入 mock runtime */
export function _setRuntimeForTests(r: AiRuntime | null): void {
  runtime = r
}

export function getPluginSystem(): PluginSystem | null {
  return pluginSystem
}

export function getRuntime(): AiRuntime {
  if (!runtime) throw new Error('AiRuntime 未初始化')
  return runtime
}

export function hasRuntime(): boolean {
  return runtime !== null
}

// ───────────────────── 配置持久化 ─────────────────────

/**
 * 从磁盘加载配置。
 *
 * 严格校验：必须包含新的 `chat`/`embedding` 字段，version===1。
 * 遇到旧 shape（如带 `active` 字段）→ 删除文件，返回 emptyConfig()，让用户在 UI 重新配。
 * 见 AGENTS.md：本仓库策略不保留历史配置、不做字段级迁移。
 * autoLink 里的未知字段会 warn 列名（手加字段拼错时不至于静默无效）。
 */
export function loadConfigFromDisk(): AiConfig {
  if (!dataDir) return emptyConfig()
  const path = join(dataDir, CONFIG_FILE)
  if (!existsSync(path)) return emptyConfig()
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (looksLikeNewShape(parsed)) {
      warnUnknownAutoLinkKeys(parsed)
      return parsed as unknown as AiConfig
    }
    // 旧 shape（含 `active` 字段或缺 chat/embedding）→ 直接丢弃
    try {
      unlinkSync(path)
      console.warn('🧠 AI: 检测到旧版 ai.config.json 已删除，请重新配置')
    } catch {
      // ignore
    }
    return emptyConfig()
  } catch {
    return emptyConfig()
  }
}

/** autoLink 未知字段告警：手加的字段如果不在 schema 里，大概率是拼错了，必须让用户知道 */
function warnUnknownAutoLinkKeys(parsed: Record<string, unknown> | null): void {
  const al = parsed?.autoLink
  if (!al || typeof al !== 'object') return
  const known = new Set([
    'enabled', 'notebookScope', 'maxPerBlock', 'minConfidence', 'minMargin',
    'excludeAnchorKinds', 'excludeSelfDoc', 'rateLimitPerMinute',
  ])
  const unknownKeys = Object.keys(al as Record<string, unknown>).filter((k) => !known.has(k))
  if (unknownKeys.length > 0) {
    console.warn(`🧠 AI: ai.config.json 的 autoLink 含未知字段（将被忽略）：${unknownKeys.join(', ')}`)
  }
}

/** 判定是否新 schema：version===1 且同时不存在 `active`（旧字段）和缺少新字段 */
function looksLikeNewShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) return false
  if ('active' in obj) return false // 旧字段
  if (!('chat' in obj) && !('embedding' in obj)) return false
  return true
}

export function saveConfigToDisk(cfg: AiConfig): void {
  if (!dataDir) throw new Error('dataDir 未初始化')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, CONFIG_FILE)
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
  try { chmodSync(path, 0o600) } catch { /* Windows 不支持 */ }
}

function loadOrSeed(): AiConfig {
  if (!dataDir) return emptyConfig()
  const path = join(dataDir, CONFIG_FILE)
  if (existsSync(path)) {
    const fromDisk = loadConfigFromDisk()
    if (fromDisk.chat || fromDisk.embedding || fromDisk.reranker) return fromDisk
  }
  // 首次启动：从环境变量种子
  const seeded = configFromEnv(process.env)
  if (seeded.chat || seeded.embedding || seeded.reranker) {
    saveConfigToDisk(seeded)
    console.log('🧠 AI: 已从环境变量种子初始化配置（写入 ' + path + '）')
  }
  return seeded
}

// ───────────────────── 热重载 ─────────────────────

export interface ReloadResult {
  ok: boolean
  errors: string[]
  status: ReturnType<AiRuntime['status']>
}

export function applyNewConfig(
  cfg: AiConfig,
  sys: PluginSystem,
): ReloadResult {
  const r = getRuntime()
  const result = r.reload(cfg)
  markVectorStoreStaleIfModelChanged(
    cfg.embedding ? embeddingFingerprint(cfg.embedding) : null,
  )
  saveConfigToDisk(cfg)
  sys.note.afterCreate.untap(HOOK_NAME)
  sys.note.afterUpdate.untap(HOOK_NAME)
  sys.note.afterDelete.untap(HOOK_NAME)
  sys.note.afterCreate.untap(AUTOLINK_HOOK_NAME)
  sys.note.afterUpdate.untap(AUTOLINK_HOOK_NAME)
  sys.note.afterDelete.untap(AUTOLINK_HOOK_NAME)
  applyAutoIndex(r, sys)
  applyAutoLink(r, sys)
  return { ok: result.ok, errors: result.errors, status: r.status() }
}

export function applyNewConfigFromCurrent(cfg: AiConfig): ReloadResult {
  if (!pluginSystem) {
    throw new Error('pluginSystem 未注入，无法应用配置')
  }
  return applyNewConfig(cfg, pluginSystem)
}

function applyAutoIndex(r: AiRuntime, pluginSystem: PluginSystem): void {
  const cfg = r.status().config
  if (!r.hasEmbedding() || !cfg.autoIndex) return

  pluginSystem.note.afterCreate.tap(HOOK_NAME, async (block) => {
    // 文档级索引作业进行中时跳过：由 indexJobs 批处理，避免双重 embed
    const docId = block.type === 'document' ? block.id : block.root_id
    const job = getLatestIndexJobForDoc(docId)
    if (job && (job.state === 'pending' || job.state === 'running')) return
    await indexBlock(block.id)
  })
  pluginSystem.note.afterUpdate.tap(HOOK_NAME, async (block) => {
    // 标题（document）/章节（heading）是索引文本的上下文：自身 content 变了，
    // 子孙块的索引文本也跟着变，需整篇重索引（hasFreshVector 会跳过未变块，成本低）
    if (block.type === 'document' || block.type === 'heading') {
      const rootId = block.type === 'document' ? block.id : block.root_id
      const blockIds = fetchDocBlocks(getDb(), rootId).map((r) => r.id)
      scheduleDocIndex(rootId, blockIds)
      return
    }
    await indexBlock(block.id)
  })
  pluginSystem.note.afterDelete.tap(HOOK_NAME, async (blockId) => {
    await deleteVector(blockId)
  })
  console.log('🧠 AI auto-index hooks attached')
}

function applyAutoLink(r: AiRuntime, pluginSystem: PluginSystem): void {
  const cfg = r.status().config
  if (!r.hasChat() || !cfg.autoLink?.enabled) return

  const al = cfg.autoLink
  // 打印生效中的 AutoLink 配置（磁盘配置是否被读取一目了然）
  console.log(`🧠 AI auto-link: 高置信自动建链, scope=${al.notebookScope}, maxPerBlock=${al.maxPerBlock}, minConfidence=${al.minConfidence}, minMargin=${al.minMargin}, excludeKinds=[${(al.excludeAnchorKinds ?? []).join(',')}], excludeSelfDoc=${al.excludeSelfDoc}, rateLimit=${al.rateLimitPerMinute}/min`)

  const scope = al.notebookScope
  const max = al.maxPerBlock

  pluginSystem.note.afterCreate.tap(AUTOLINK_HOOK_NAME, async (block) => {
    if (isBlockAiExcluded(block.id)) return
    if (isDocInboxOrArchived(block)) return
    await analyzeBlock({
      blockId: block.id,
      content: block.content,
      notebookId: block.notebook_id,
      notebookScope: scope,
      maxPerBlock: max,
      // 文档根（标题）：强实体信号，只登记实体不建链
      entitiesOnly: block.type === 'document',
    }).catch((e) => console.warn('[autoLink] afterCreate:', e instanceof Error ? e.message : e))
  })
  pluginSystem.note.afterUpdate.tap(AUTOLINK_HOOK_NAME, async (block) => {
    if (isBlockAiExcluded(block.id)) return
    if (isDocInboxOrArchived(block)) return
    // 内容变化 = 旧链/旧提及重评：双清理（该块发出的 ai_auto 引用 + 实体提及），再按新内容重建
    deleteRefsFromSource(getDb(), block.id, 'ai_auto')
    deleteMentionsFromSource(getDb(), block.id)
    await analyzeBlock({
      blockId: block.id,
      content: block.content,
      notebookId: block.notebook_id,
      notebookScope: scope,
      maxPerBlock: max,
      entitiesOnly: block.type === 'document',
    }).catch((e) => console.warn('[autoLink] afterUpdate:', e instanceof Error ? e.message : e))
  })
  // 块软删除的引用/提及级联由 store 层 deleteRefsTouchingBlocks + deleteMentionsTouchingBlocks 覆盖，无需 afterDelete hook
  console.log('🧠 AI auto-link hooks attached')
}

/** inbox / archived 文档不做自动建链（与检索默认过滤语义一致） */
function isDocInboxOrArchived(block: Block): boolean {
  const docId = block.type === 'document' ? block.id : block.root_id
  const doc = getDocById(getDb(), docId)
  return doc?.status === 'inbox' || doc?.status === 'archived'
}
