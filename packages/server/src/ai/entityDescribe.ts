/**
 * 实体一句话描述生成（E2）—— 后台 LLM，自重排单循环
 *
 * 实体从「关键词」变成「概念」：给 mention_count ≥ 3 的实体生成一句话描述，
 * 写入 entities.description（界面 tooltip / 详情面板展示；不进检索/索引文本）。
 *
 * 触发：startEntityDescribe() 启动自重排循环，每圈取 BATCH 个待生成实体，
 * 经独立限速窗口调 LLM。无 chat 配置 / autoLink 关闭 / 无可生成实体时统一走
 * 低频档（60s）重排——配置热重载后无需重新调用 startEntityDescribe，下一圈
 * 自然生效；任何瞬时失败都不会让循环终止。失败实体进 30 分钟冷却，不反复烧 token。
 * 描述变更不触发块重索引（v1 不进 indexed text，hash 语义不受影响）。
 */

import type { ChatMessage } from '@notefast/core'
import { getDb } from '../db'
import {
  DESC_MIN_MENTIONS,
  getEntityById,
  listEntitiesNeedingDescription,
  listEntityMentions,
  updateEntityDescription,
} from '../store/entities'
import { getRuntime, hasRuntime } from '../services/aiRuntime'

/** 每圈处理上限（防止一次性刷太多 token） */
const BATCH = 2
/** 描述生成限速：独立于 autoLink 的滑动窗口，避免抢 AutoLink 的 chat 配额 */
const RATE_PER_MINUTE = 8
/** 兜底：LLM 返回过长时截断（一句描述，80 字内足够） */
const DESC_MAX = 80
/** 取提及上下文上限（块） */
const CONTEXT_BLOCKS = 6
/** 有产出（成功生成描述）时的短间隔 */
const BUSY_INTERVAL_MS = 15_000
/** 低频档间隔：无配置 / autoLink 关闭 / 无待办 / 全部失败 / 异常兜底 */
const IDLE_INTERVAL_MS = 60_000
/** 失败冷却：同一实体生成失败后 30 分钟内不再重试（防推理模型空响应反复烧 token） */
const FAIL_COOLDOWN_MS = 30 * 60_000

/** 失败冷却表：entityId → 冷却截止时间戳（内存级，进程重启自然清零） */
const failCooldownUntil = new Map<string, number>()

const SYSTEM_PROMPT = `你是知识库的整理助手。基于给出的提及上下文，用一句不超过 40 字的中文说明这个实体「是什么」。
规则：
- 只输出这句话本身，不要任何前缀、引号或标点说明。
- 如果上下文不足以判断实体类型，给出通用的归类描述（如「一个概念/工具/人物」）。
- 不要评价内容好坏，不要复述原文。`

function buildPrompt(display: string, snippets: string[]): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `实体：${display}\n\n提及上下文：\n${snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    },
  ]
}

// ───────────────────── 限速（独立滑动窗口）─────────────────────
let rateStart = 0
let rateCount = 0

function hitRateLimit(): boolean {
  const now = Date.now()
  if (now - rateStart >= 60_000) {
    rateStart = now
    rateCount = 0
  }
  rateCount++
  return rateCount > RATE_PER_MINUTE
}

/** 测试用：重置限速窗口与失败冷却表 */
export function _resetDescribeRateLimitForTests(): void {
  rateStart = 0
  rateCount = 0
  failCooldownUntil.clear()
}

// ───────────────────── 单实体生成 ─────────────────────

/** 为单个实体生成描述并落库；返回是否生成成功 */
export async function describeEntity(entityId: string): Promise<boolean> {
  if (!hasRuntime() || !getRuntime().hasChat()) return false
  const db = getDb()
  const entity = getEntityById(db, entityId)
  if (!entity || entity.description) return false
  if ((entity.mention_count ?? 0) < DESC_MIN_MENTIONS) return false

  const snippets = listEntityMentions(db, entityId)
    .slice(0, CONTEXT_BLOCKS)
    .map((m) => (m.block_content ?? '').slice(0, 200))
    .filter(Boolean)
  if (snippets.length === 0) return false

  let desc: string
  try {
    desc = await getRuntime().chat(buildPrompt(entity.display, snippets), {
      temperature: 0,
      // 推理模型的 think 会吃掉 token 预算：默认值（200）常被思考耗光导致空响应
      // （与 autoLink 的 1500 同一教训），空响应又会让该实体下圈被重复选中
      maxTokens: 1500,
    })
  } catch {
    return false
  }
  // 防御：剥离推理模型可能残留的 <think> 与代码围栏
  const clean = desc
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/^```\w*\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/^["'「《\s]+|["'」》\s]+$/g, '')
    .trim()
    .slice(0, DESC_MAX)
  if (!clean) return false

  updateEntityDescription(db, entityId, clean)
  return true
}

// ───────────────────── 自重排循环 ─────────────────────

/**
 * 单圈处理；返回是否有产出（决定下一圈间隔档位）。
 * 无 chat 配置 / autoLink 关闭 / 无待办实体均返回 false —— 由调用方统一走低频档重排，
 * 这样设置页配好 chat 后无需重新调用 startEntityDescribe，下一圈自然生效。
 */
async function runPass(): Promise<boolean> {
  // 后台循环跟随 autoLink.enabled：用户关掉 autoLink 即不再主动消耗 LLM。
  // 手动「重新生成描述」（POST describe）走 describeEntity，不受此 gate。
  if (!hasRuntime() || !getRuntime().hasChat()) return false
  if (!getRuntime().autoLinkConfig().enabled) return false
  const ids = listEntitiesNeedingDescription(getDb(), BATCH)
  if (ids.length === 0) return false

  let processed = 0
  const now = Date.now()
  for (const row of ids) {
    // 失败冷却：生成失败过的实体在冷却窗内跳过，不反复烧 token
    if ((failCooldownUntil.get(row.id) ?? 0) > now) continue
    if (hitRateLimit()) continue
    if (await describeEntity(row.id)) {
      failCooldownUntil.delete(row.id)
      processed++
    } else {
      failCooldownUntil.set(row.id, now + FAIL_COOLDOWN_MS)
    }
  }
  return processed > 0
}

/**
 * 自重排单循环：一圈跑完（无论成功、空转还是抛错）都 sleep 后重排自身。
 * 任何失败只影响间隔档位（统一走低频档），循环永不终止、不产生 unhandled rejection。
 */
async function runLoop(): Promise<void> {
  let busy = false
  try {
    busy = await runPass()
  } catch {
    // 瞬时错误（DB / runtime 热重载中途等）：静默，走低频档重试
  }
  await sleep(busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS)
  void runLoop()
}

/** 启动实体描述生成循环（进程级常驻；无 AI 配置时低频空转） */
export function startEntityDescribe(): void {
  void runLoop()
}

/** 测试专用：直接执行单圈（不进入自重排循环），返回是否有产出 */
export const _runDescribePassForTests = runPass

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
