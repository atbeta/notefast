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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AiRuntime,
  configFromEnv,
  emptyConfig,
  setAiRuntime,
  type AiConfig,
} from '@notefast/core'
import type { PluginSystem } from '@notefast/core'
import { indexBlock, deleteVector } from '../ai/indexer'
import { analyzeBlock } from '../ai/autoLink'
import { removeSuggestionsForBlock } from '../ai/autoLinkStore'

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
  const initial = loadOrSeed()
  const r = new AiRuntime(initial)
  runtime = r
  setAiRuntime(r)
  applyAutoIndex(r, sys)
  applyAutoLink(r, sys)
  return r
}

/** 测试用：注入 mock runtime */
export function _setRuntimeForTests(r: AiRuntime | null): void {
  runtime = r
  if (r) setAiRuntime(r)
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
 * 见 AGENTS.md：本仓库策略不保留历史配置。
 */
export function loadConfigFromDisk(): AiConfig {
  if (!dataDir) return emptyConfig()
  const path = join(dataDir, CONFIG_FILE)
  if (!existsSync(path)) return emptyConfig()
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (looksLikeNewShape(parsed)) return parsed as unknown as AiConfig
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
    await indexBlock(block.id)
  })
  pluginSystem.note.afterUpdate.tap(HOOK_NAME, async (block) => {
    await indexBlock(block.id)
  })
  pluginSystem.note.afterDelete.tap(HOOK_NAME, async (blockId) => {
    deleteVector(blockId)
  })
  console.log('🧠 AI auto-index hooks attached')
}

function applyAutoLink(r: AiRuntime, pluginSystem: PluginSystem): void {
  const cfg = r.status().config
  if (!r.hasChat() || !cfg.autoLink?.enabled) return

  const scope = cfg.autoLink.notebookScope
  const max = cfg.autoLink.maxPerBlock

  pluginSystem.note.afterCreate.tap(AUTOLINK_HOOK_NAME, async (block) => {
    if (block.type === 'document') return // doc 头不分析
    removeSuggestionsForBlock(block.id)
    await analyzeBlock({
      blockId: block.id,
      content: block.content,
      notebookId: block.notebook_id,
      notebookScope: scope,
      maxPerBlock: max,
    }).catch((e) => console.warn('[autoLink] afterCreate:', e instanceof Error ? e.message : e))
  })
  pluginSystem.note.afterUpdate.tap(AUTOLINK_HOOK_NAME, async (block) => {
    if (block.type === 'document') return
    removeSuggestionsForBlock(block.id)
    await analyzeBlock({
      blockId: block.id,
      content: block.content,
      notebookId: block.notebook_id,
      notebookScope: scope,
      maxPerBlock: max,
    }).catch((e) => console.warn('[autoLink] afterUpdate:', e instanceof Error ? e.message : e))
  })
  pluginSystem.note.afterDelete.tap(AUTOLINK_HOOK_NAME, async (blockId) => {
    removeSuggestionsForBlock(blockId)
  })
  console.log('🧠 AI auto-link hooks attached')
}

// ───────────────────── 工具 ─────────────────────

export function configFilePath(): string {
  return join(dataDir, CONFIG_FILE)
}