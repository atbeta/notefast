/**
 * vault 首次对账性能基准（V-501，RFC 0002 §验证标准）
 *
 * 生成合成 vault（默认 1000 篇）到临时目录，走**真实运行时**（createVaultRuntime →
 * reconcileVault → ingestVaultFile）计时，输出：文件数 / 总墙钟 / 分阶段耗时 /
 * files-per-sec / 采样峰值 RSS / 单文件变更 → 可搜延迟。跑完清理临时目录，不留 fixture。
 *
 * 用法（任选其一）：
 *   bun --filter @notefast/server bench:vault
 *   bun --filter @notefast/server bench:vault --files 10000
 *   bun run packages/server/src/eval/vaultBench.ts --files 1000 --out /tmp/vault-bench.json
 *   VAULT_BENCH_FILES=10000 bun --filter @notefast/server bench:vault
 *
 * 参数（缺省值 = bench 口径；与生产默认的差异见「口径说明」）：
 *   --files <n>            文件数（默认 1000；env VAULT_BENCH_FILES）
 *   --blocks-per-file <n>  每篇正文块数（默认 12；内容 profile，越大越慢）
 *   --dirs <n>             子目录数（默认 32）
 *   --stability-ms <n>     编辑器写盘合并窗口（默认 300，= VAULT_STABILITY_MS 默认）
 *   --native               用原生文件事件（默认轮询，见下）
 *   --poll-interval-ms <n> 轮询间隔（默认 100，仅轮询模式生效）
 *   --no-writeback         关闭写回（默认开启，与 VAULT_WRITEBACK 默认一致）
 *   --shadow               **不**暂停影子副本写盘（默认暂停，见下）
 *   --latency-iters <n>    变更→可搜迭代次数（默认 3，取中位数）
 *   --latency-warmup <n>   预热迭代（默认 2，不计入中位数；前两次变更含 watcher 冷启动）
 *   --start-timeout-ms <n> 等 watcher ready 的兜底超时（默认 60000；进入对账后不再打断）
 *   --keep                 保留临时目录（调试用）
 *   --out <path>           额外写一份 JSON 报告（必须落在 /tmp 下）
 *
 * 口径说明：
 *   - 对账期间默认 `pauseShadowWrites()`（计划 V-501 要点；与批量导入 `api/import.ts` 同款），
 *     影子副本 `data/markdown/` 的写盘不计入对账耗时。`--shadow` 可对照生产现状（未暂停）。
 *   - 「可搜」= FTS5 MATCH 轮询命中新写入内容（FTS 触发器同步，等价于 SQLite 可见），
 *     命中后再用真实 `lexicalSearch` 复核一次。用 FTS 而非 lexicalSearch 轮询的原因：
 *     后者未命中时会走 LIKE 全表回退，5ms 一次会把事件循环打满、反过来拖慢 ingest。
 *   - watcher 模式对「变更→可搜」影响极大：bench 的 vault 落在 macOS 临时目录，
 *     chokidar 原生事件（Bun 1.3.14）在这里会延迟十几秒、丢事件，甚至卡在初始扫描不返回
 *     （卡住时连 JS 定时器都不触发，`--start-timeout-ms` 兜不住，只能 Ctrl-C）。
 *     因此**默认轮询**（与 Docker bind mount 同理，AGENTS.md 已有同款告诫），`--native` 仅作对照。
 *   - 内存为 25ms 采样峰值 RSS（Bun 含 SQLite / 原生扩展，非纯堆），只做量级参考。
 *   - 单次进程只跑一个文件数：RSS 峰值与 SQLite 页缓存不被前一轮污染。10k 请单独起进程。
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createPluginSystem } from '@notefast/core'
import { closeDb, getDb, initDb } from '../db'
import { initVectorStore } from '../ai/indexer'
import { _setRuntimeForTests, initAiRuntime } from '../services/aiRuntime'
import { initDocEvents } from '../services/docEvents'
import {
  initShadowMarkdown,
  pauseShadowWrites,
  resumeShadowWrites,
  stopShadowMarkdown,
} from '../services/shadowMarkdown'
import { lexicalSearch } from '../lexicalSearch'
import { listVaultFiles } from '../store/vaultFiles'
import { listUnresolvedByTargetNames } from '../store/vaultLinks'
import { createVaultRuntime, type VaultRuntime } from '../vault'
import { DEFAULT_VAULT_IGNORE, type VaultConfig } from '../vault/config'
import { ingestVaultFile, listVaultMarkdownFiles, reconcileVault, type ReconcileStats } from '../vault/ingest'
import { buildVaultFileIndex, wikilinkNamesForPath } from '../vault/wikilinks'

/** 仓库根目录（本文件在 packages/server/src/eval/ 下） */
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

// ───────────────────── CLI ─────────────────────

interface BenchOptions {
  files: number
  blocksPerFile: number
  dirs: number
  stabilityMs: number
  usePolling: boolean
  pollIntervalMs: number
  writeback: boolean
  pauseShadow: boolean
  latencyIters: number
  latencyWarmup: number
  startTimeoutMs: number
  keep: boolean
  out: string | null
}

function parseArgs(argv: string[]): BenchOptions {
  const raw: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      raw[a.slice(2)] = next
      i++
    } else {
      raw[a.slice(2)] = true
    }
  }
  const num = (key: string, fallback: number): number => {
    const v = raw[key]
    if (v === undefined || v === true) return fallback
    const n = Number.parseInt(String(v), 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const envFiles = Number.parseInt(process.env.VAULT_BENCH_FILES ?? '', 10)
  return {
    files: num('files', Number.isFinite(envFiles) && envFiles > 0 ? envFiles : 1000),
    blocksPerFile: num('blocks-per-file', 12),
    dirs: num('dirs', 32),
    stabilityMs: num('stability-ms', 300),
    usePolling: raw.native !== true,
    pollIntervalMs: num('poll-interval-ms', 100),
    writeback: raw['no-writeback'] !== true,
    pauseShadow: raw.shadow !== true,
    latencyIters: num('latency-iters', 3),
    latencyWarmup: raw['latency-warmup'] === true ? 2 : num('latency-warmup', 2),
    startTimeoutMs: num('start-timeout-ms', 60_000),
    keep: raw.keep === true,
    out: typeof raw.out === 'string' ? raw.out : null,
  }
}

// ───────────────────── 合成语料 ─────────────────────

/** 确定性 PRNG（mulberry32）：同一 i 恒同内容，便于跨机器 / 跨版本对比 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 一篇合成笔记：H1（= 文件名，会走 stripTitleHeading）+ frontmatter（部分）+
 * 段落 / 列表 / 代码 / callout / wikilink / `^id` / `$$` 混合，贴近 Obsidian 真实语料。
 * 内容只依赖 (i, blocksPerFile, dirs)，与总文件数无关。
 */
function synthNote(i: number, blocksPerFile: number, dirs: number): { rel: string; content: string } {
  const rnd = mulberry32(0x9e3779b9 ^ i)
  const title = `note-${i}`
  const rel = `notes/g${String(i % dirs).padStart(3, '0')}/${title}.md`
  const linkTarget = (i * 13 + 7) % 1000 + 1
  const out: string[] = []

  if (i % 3 === 0) {
    out.push('---', `tags: [bench, group-${i % 7}]`, 'aliases:', `  - ${title}-alias`, '---', '')
  }
  out.push(`# ${title}`, '')
  out.push(
    `Intro for ${title}. unique token nfbench-${i}. ` +
      `This paragraph exists so the parser produces a real paragraph block with prose around it.`,
    '',
  )

  for (let b = 0; b < blocksPerFile; b++) {
    switch (b % 6) {
      case 0:
        out.push(
          `## 小节 ${b}`,
          '',
          `正文段落 ${b}，包含若干中文与 ASCII 词汇便于 FTS 分词，随机值 ${rnd().toFixed(6)}。`,
          '',
        )
        break
      case 1:
        out.push('- 条目一：解析器要能认出列表项', `- 条目二：[[note-${linkTarget}|别名]]`, '')
        break
      case 2:
        out.push('```ts', `const value${b} = ${i} + ${b}`, '```', '')
        break
      case 3:
        out.push('> [!note] callout 标题', `> callout 正文 ${b}`, '')
        break
      case 4:
        out.push(`段落带块锚点，便于写回往返测试 ^blk${i}-${b}`, '')
        break
      default:
        out.push('$$', `x_{${b}} = y_{${b}} + 1`, '$$', '')
        break
    }
  }
  return { rel, content: out.join('\n') }
}

interface GeneratedVault {
  files: number
  bytes: number
}

function generateVault(root: string, opts: BenchOptions): GeneratedVault {
  let bytes = 0
  let lastDir = ''
  for (let i = 1; i <= opts.files; i++) {
    const { rel, content } = synthNote(i, opts.blocksPerFile, opts.dirs)
    const dir = dirname(rel)
    if (dir !== lastDir) {
      mkdirSync(join(root, dir), { recursive: true })
      lastDir = dir
    }
    writeFileSync(join(root, rel), content, 'utf8')
    bytes += Buffer.byteLength(content)
  }
  return { files: opts.files, bytes }
}

// ───────────────────── 内存采样 ─────────────────────

interface MemorySampler {
  stop: () => { peakRssMb: number; peakHeapMb: number; rssAtStopMb: number }
}

function startMemorySampler(intervalMs = 25): MemorySampler {
  let peakRss = 0
  let peakHeap = 0
  const sample = (): void => {
    const m = process.memoryUsage()
    if (m.rss > peakRss) peakRss = m.rss
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed
  }
  sample()
  const timer = setInterval(sample, intervalMs)
  return {
    stop: () => {
      clearInterval(timer)
      sample()
      return {
        peakRssMb: peakRss / 1024 / 1024,
        peakHeapMb: peakHeap / 1024 / 1024,
        rssAtStopMb: process.memoryUsage().rss / 1024 / 1024,
      }
    },
  }
}

// ───────────────────── 计时工具 ─────────────────────

interface Phase {
  name: string
  ms: number
  note?: string
}

async function timed<T>(phases: Phase[], name: string, fn: () => Promise<T> | T, note?: string): Promise<T> {
  const t0 = performance.now()
  const out = await fn()
  phases.push({ name, ms: performance.now() - t0, ...(note ? { note } : {}) })
  return out
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

// ───────────────────── 主流程 ─────────────────────

interface LatencySample {
  iter: number
  relPath: string
  token: string
  ms: number
  /** 轮询单次开销（FTS MATCH） */
  pollAvgMs: number
  /** 命中后 lexicalSearch 复核是否也能拿到 */
  confirmed: boolean
  /** 超时后手动轻量对账能否补上（true = watcher 丢事件，而非 ingest 慢） */
  recoveredByReconcile: boolean
}

interface BenchReport {
  options: BenchOptions
  profile: { files: number; blocks: number; vaultBytes: number; dirs: number }
  phases: Phase[]
  reconcile: ReconcileStats | null
  filesPerSec: number
  memory: { peakRssMb: number; peakHeapMb: number; rssAtStopMb: number }
  latency: {
    samples: LatencySample[]
    warmupMs: number[]
    medianMs: number
    budgetMs: number
    pass: boolean
  }
  probes: {
    listVaultFilesMs: number
    buildVaultFileIndexMs: number
    unresolvedLookupMs: number
    warmIngestMs: number
    scaleIngestMs: number
    scaleIngestFiles: number
  }
  targets: { reconcile1000: boolean | null; changeSearchable: boolean }
  suppressedLogLines: number
}

/**
 * 静音逐文件审计日志（`safeLog` 的 JSON 行，1000/10000 行会淹没 stdout 并拖慢计时）。
 * 审计**照常写 app_logs**（那是对账成本的一部分），只掐 console 输出；结束时恢复并报计数。
 */
function installQuietAuditLogs(): { restore: () => number } {
  const originalLog = console.log
  const originalWarn = console.warn
  let suppressed = 0
  const wrap = (real: typeof console.log): typeof console.log =>
    ((...args: unknown[]) => {
      const first = args[0]
      if (typeof first === 'string' && first.startsWith('{"ts":"')) {
        suppressed++
        return
      }
      real(...args)
    }) as typeof console.log
  console.log = wrap(originalLog)
  console.warn = wrap(originalWarn)
  return {
    restore: () => {
      console.log = originalLog
      console.warn = originalWarn
      return suppressed
    },
  }
}

/** 改一个文件 → 轮询 FTS 直到新内容可搜；返回毫秒（超时 NaN）+ 轮询开销 */
async function measureChangeToSearchable(
  runtime: VaultRuntime,
  vaultRoot: string,
  rel: string,
  token: string,
  notebookId: string,
): Promise<{ ms: number; pollAvgMs: number; confirmed: boolean; recoveredByReconcile: boolean }> {
  const abs = join(vaultRoot, rel)
  const content = `${readFileSync(abs, 'utf8')}\n\nLatency probe ${token} with enough words to be indexed.\n`
  // 轮询走 FTS5 MATCH（就是 lexicalSearch 的 FTS 腿，索引查找，不触发 LIKE 全表扫）：
  // 若用 lexicalSearch 每 5ms 轮询，未命中时的 LIKE 回退会把事件循环打满，反过来拖慢 ingest。
  const fts = getDb().query('SELECT 1 AS hit FROM blocks_fts WHERE blocks_fts MATCH ? LIMIT 1')
  const matchExpr = `"${token}"`
  const t0 = performance.now()
  writeFileSync(abs, content, 'utf8')
  let hitMs = Number.NaN
  let polls = 0
  let pollTotal = 0
  const deadline = t0 + 30_000
  while (performance.now() < deadline) {
    const p0 = performance.now()
    const row = fts.get(matchExpr) as { hit: number } | null
    pollTotal += performance.now() - p0
    polls++
    if (row) {
      hitMs = performance.now() - t0
      break
    }
    await Bun.sleep(5)
  }
  // 超时诊断：手动跑一次轻量对账，能补上 = 事件被 watcher 丢了，而不是 ingest 慢
  let recoveredByReconcile = false
  if (Number.isNaN(hitMs)) {
    await reconcileVault(runtime.ctx, { light: true })
    recoveredByReconcile = Boolean(fts.get(matchExpr))
  }
  // 命中后用真实 lexicalSearch 复核一次（确认走完整词法路径也能拿到）
  const confirmed =
    !Number.isNaN(hitMs) &&
    lexicalSearch(token, { limit: 5, notebookId }).some((h) => (h.content ?? '').includes(token))
  if (!Number.isNaN(hitMs)) await runtime.idle()
  return { ms: hitMs, pollAvgMs: polls > 0 ? pollTotal / polls : 0, confirmed, recoveredByReconcile }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const phases: Phase[] = []
  const sampler = startMemorySampler()
  const quiet = installQuietAuditLogs()
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'notefast-vault-bench-')))
  const dataDir = join(tmpRoot, 'data')
  const vaultRoot = join(tmpRoot, 'vault')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(vaultRoot, { recursive: true })

  let runtime: VaultRuntime | null = null
  let shadowPaused = false
  let exitCode = 0

  try {
    const gen = await timed(phases, 'generate', () => generateVault(vaultRoot, opts), `${opts.files} 篇`)
    console.log(
      `📂 合成 vault: ${gen.files} 篇 / ${(gen.bytes / 1024 / 1024).toFixed(1)} MiB / ${opts.blocksPerFile} 块每篇 / ${opts.dirs} 目录`,
    )
    console.log(
      `⚙️  stabilityMs=${opts.stabilityMs} watcher=${opts.usePolling ? `polling(${opts.pollIntervalMs}ms)` : 'native'} writeback=${opts.writeback ? 'on' : 'off'} shadow=${opts.pauseShadow ? 'paused' : 'live'}`,
    )
    if (!opts.usePolling) {
      console.warn('⚠️  --native：chokidar 原生事件在本环境可能长时间卡在初始扫描（Bun 1.3.14），必要时 Ctrl-C；结论请以默认轮询为准')
    }

    // 真实启动顺序（app.ts）：initDb → initVectorStore → plugin/ai/docEvents/shadow → vault runtime
    const { notebookId } = await timed(phases, 'db_init', () => {
      const { notebookId: nb } = initDb(dataDir)
      return { notebookId: nb }
    })
    await timed(phases, 'vector_init', () => initVectorStore())
    await timed(phases, 'services_init', () => {
      const pluginSystem = createPluginSystem()
      initAiRuntime(pluginSystem, dataDir)
      initDocEvents(pluginSystem)
      initShadowMarkdown(dataDir)
    })

    const config: VaultConfig = {
      root: vaultRoot,
      ignore: [...DEFAULT_VAULT_IGNORE],
      watch: true,
      writeback: opts.writeback,
      stabilityMs: opts.stabilityMs,
      usePolling: opts.usePolling,
      pollIntervalMs: opts.pollIntervalMs,
      reconcileMinutes: 0,
    }
    runtime = createVaultRuntime({ db: getDb(), notebookId, config })

    if (opts.pauseShadow) {
      pauseShadowWrites()
      shadowPaused = true
    }
    const startMs = await timed(phases, 'start_total', async () => {
      const t0 = performance.now()
      // 兜底超时只针对「watcher ready 卡住」：原生事件在临时目录下可能永远不 ready。
      // 到点时若对账已在跑（status().reconciling）就放行——对账时长本身就是要测的数。
      let guard: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<never>((_, reject) => {
        guard = setTimeout(() => {
          if (runtime!.status().reconciling) return
          reject(
            new Error(
              `runtime.start() 超过 ${opts.startTimeoutMs}ms 仍未进入对账——原生事件在临时目录下常卡在 watcher ready；去掉 --native（默认轮询）再试`,
            ),
          )
        }, opts.startTimeoutMs)
      })
      try {
        await Promise.race([runtime!.start({ awaitReconcile: true }), timeout])
      } finally {
        if (guard) clearTimeout(guard)
      }
      return performance.now() - t0
    })
    // 对账已返回，但写回队列 / doc 事件可能还在排空：等空闲才是「端到端可服务」
    await timed(phases, 'settle_idle', () => runtime!.idle())

    const stats = runtime.status().last_reconcile
    if (!stats) throw new Error('未拿到对账统计（last_reconcile 为空）')
    phases.push({ name: 'reconcile', ms: stats.durationMs, note: 'reconcileVault 自计时长' })
    console.log(
      `✅ 首次对账: +${stats.created} ~${stats.updated} =${stats.unchanged} 错误=${stats.errors.length}，${fmtMs(stats.durationMs)}`,
    )
    console.log(`⏱️  start() 墙钟（含 watcher ready + 对账）: ${fmtMs(startMs)}`)

    // 落库校验：文件数 / 块数 / 映射行数应一致
    const db = getDb()
    const blockCount = (db.query('SELECT count(*) AS c FROM blocks WHERE is_deleted = 0').get() as { c: number }).c
    const fileRows = listVaultFiles(db, notebookId).length
    const diskFiles = (await listVaultMarkdownFiles(config)).length
    const refCount = (db.query('SELECT count(*) AS c FROM block_refs').get() as { c: number }).c
    console.log(
      `📊 落库: 磁盘 ${diskFiles} 篇 / 映射 ${fileRows} 行 / 活块 ${blockCount} / wikilink refs ${refCount}`,
    )

    // 轻量对账（V-404 定时兜底路径）：已知文件只 stat，不读盘
    const light = await timed(phases, 'reconcile_light', () => reconcileVault(runtime!.ctx, { light: true }))
    console.log(`🔎 轻量对账: stat_skipped=${light.stat_skipped} unchanged=${light.unchanged}，${fmtMs(light.durationMs)}`)

    // 热点探针：ingest 每个新文件都会调 buildVaultFileIndex → listVaultFiles 全表扫（见报告）
    const listMs = await timed(phases, 'probe_listVaultFiles', () => {
      const t0 = performance.now()
      listVaultFiles(db, notebookId)
      return performance.now() - t0
    })
    const indexMs = await timed(phases, 'probe_buildVaultFileIndex', () => {
      const t0 = performance.now()
      buildVaultFileIndex(runtime!.ctx)
      return performance.now() - t0
    })
    // resolveUnresolvedForDoc 每次 ingest 都按目标名反查一次未解析表（lower(target_name) 无索引）
    const unresolvedMs = await timed(phases, 'probe_unresolvedLookup', () => {
      const names = wikilinkNamesForPath('notes/g001/note-1.md')
      const t0 = performance.now()
      listUnresolvedByTargetNames(db, notebookId, names)
      return performance.now() - t0
    })
    console.log(
      `🔬 探针: listVaultFiles ${listMs.toFixed(1)}ms / buildVaultFileIndex ${indexMs.toFixed(1)}ms / ` +
        `unresolvedLookup ${unresolvedMs.toFixed(2)}ms（前两项每次 ingest 各调一次）`,
    )

    // 稳态单文件成本：已入库文件走 sha 短路 → unchanged
    const warmCount = Math.min(20, opts.files)
    const warmPaths: string[] = []
    for (let i = 1; i <= warmCount; i++) warmPaths.push(synthNote(i, opts.blocksPerFile, opts.dirs).rel)
    let warmTotal = 0
    for (const rel of warmPaths) {
      const t0 = performance.now()
      const r = await ingestVaultFile(runtime.ctx, rel)
      warmTotal += performance.now() - t0
      if (r.action !== 'unchanged') {
        console.warn(`⚠️  稳态探针期望 unchanged，实际 ${r.action}: ${rel}`)
      }
    }
    const warmIngestMs = warmTotal / warmCount
    phases.push({ name: 'probe_warm_ingest', ms: warmTotal, note: `${warmCount} 篇平均 ${warmIngestMs.toFixed(1)}ms` })

    // 规模下的边际单文件成本：库已有 N 篇时再新增一批，逐个计时（对照首次对账的均值）
    const scaleCount = Math.min(50, Math.max(10, Math.round(opts.files / 200)))
    let scaleTotal = 0
    let scaleCreated = 0
    for (let k = 0; k < scaleCount; k++) {
      const i = opts.files + 1 + k
      const { rel, content } = synthNote(i, opts.blocksPerFile, opts.dirs)
      mkdirSync(join(vaultRoot, dirname(rel)), { recursive: true })
      writeFileSync(join(vaultRoot, rel), content, 'utf8')
      const t0 = performance.now()
      const r = await ingestVaultFile(runtime.ctx, rel)
      scaleTotal += performance.now() - t0
      if (r.action === 'created') scaleCreated++
      else console.warn(`⚠️  规模探针: ${rel} → ${r.action}（watcher 抢先入库？计时会偏小）`)
    }
    const scaleIngestMs = scaleTotal / scaleCount
    phases.push({
      name: 'probe_ingest_at_scale',
      ms: scaleTotal,
      note: `库内 ${opts.files} 篇时平均 ${scaleIngestMs.toFixed(1)}ms/篇（created ${scaleCreated}/${scaleCount}）`,
    })
    console.log(
      `🔬 规模探针: 已有 ${opts.files} 篇时单文件 ingest ${scaleIngestMs.toFixed(1)}ms（首次对账均值 ${(stats.durationMs / Math.max(1, stats.created)).toFixed(1)}ms）`,
    )

    // 单文件变更 → 可搜（真实 watcher 路径，不走手动 ingest）
    // 预热：watcher 首次投递含 FSEvents/轮询冷启动，单独报，不计入中位数
    const budgetMs = opts.stabilityMs + 200
    const warmupMs: number[] = []
    const samples: LatencySample[] = []
    const totalIters = opts.latencyWarmup + opts.latencyIters
    for (let iter = 0; iter < totalIters; iter++) {
      const idx = ((iter * 37) % opts.files) + 1
      const rel = synthNote(idx, opts.blocksPerFile, opts.dirs).rel
      const token = `nfbenchlat-${process.pid}-${iter}`
      const probe = await measureChangeToSearchable(runtime, vaultRoot, rel, token, notebookId)
      const hitMs = probe.ms
      const isWarmup = iter < opts.latencyWarmup
      if (isWarmup) warmupMs.push(hitMs)
      else {
        samples.push({
          iter: iter - opts.latencyWarmup,
          relPath: rel,
          token,
          ms: hitMs,
          pollAvgMs: probe.pollAvgMs,
          confirmed: probe.confirmed,
          recoveredByReconcile: probe.recoveredByReconcile,
        })
      }
      console.log(
        `🔁 变更→可搜 ${isWarmup ? '预热' : `#${iter - opts.latencyWarmup}`}: ${
          Number.isNaN(hitMs) ? `超时(30s 未命中${probe.recoveredByReconcile ? '，轻量对账可补上 → watcher 丢事件' : '，轻量对账也补不上'})` : `${hitMs.toFixed(0)}ms`
        } (轮询 ${probe.pollAvgMs.toFixed(2)}ms/次${probe.confirmed ? '' : '，lexicalSearch 复核未命中'}；${rel})`,
      )
    }
    const latencies = samples.map((s) => s.ms).filter((m) => !Number.isNaN(m))
    const medianMs = latencies.length > 0 ? median(latencies) : Number.NaN
    const latencyPass =
      latencies.length === samples.length && samples.every((s) => s.confirmed) && medianMs <= budgetMs
    if (!latencyPass) exitCode = 1

    const memory = sampler.stop()
    const suppressedLogLines = quiet.restore()
    const filesPerSec = stats.durationMs > 0 ? (stats.created / stats.durationMs) * 1000 : 0
    const report: BenchReport = {
      options: opts,
      profile: { files: gen.files, blocks: blockCount, vaultBytes: gen.bytes, dirs: opts.dirs },
      phases,
      reconcile: stats,
      filesPerSec,
      memory,
      latency: { samples, warmupMs, medianMs, budgetMs, pass: latencyPass },
      probes: {
        listVaultFilesMs: listMs,
        buildVaultFileIndexMs: indexMs,
        unresolvedLookupMs: unresolvedMs,
        warmIngestMs,
        scaleIngestMs,
        scaleIngestFiles: scaleCount,
      },
      targets: {
        reconcile1000: opts.files === 1000 ? stats.durationMs < 30_000 : null,
        changeSearchable: latencyPass,
      },
      suppressedLogLines,
    }
    printSummary(report)
    if (opts.out) writeReport(opts.out, report)
    if (stats.errors.length > 0) {
      exitCode = 1
      console.error(`❌ 对账期间 ${stats.errors.length} 个错误：`)
      for (const e of stats.errors.slice(0, 10)) console.error(`   ${e.relPath}: ${e.error}`)
    }
  } catch (e) {
    exitCode = 1
    console.error('❌ bench 失败:', e instanceof Error ? (e.stack ?? e.message) : e)
  } finally {
    quiet.restore()
    if (shadowPaused) resumeShadowWrites()
    try {
      await runtime?.stop()
    } catch (e) {
      console.warn('stop() 失败:', e instanceof Error ? e.message : e)
    }
    stopShadowMarkdown()
    _setRuntimeForTests(null)
    try {
      closeDb()
    } catch {
      /* 已关闭 */
    }
    if (!opts.keep) {
      rmSync(tmpRoot, { recursive: true, force: true })
      console.log(`🧹 已清理 ${tmpRoot}`)
    } else {
      console.log(`📁 保留临时目录 ${tmpRoot}`)
    }
  }
  process.exit(exitCode)
}

// ───────────────────── 输出 ─────────────────────

function printSummary(r: BenchReport): void {
  console.log('')
  console.log('── V-501 vault bench ─────────────────────────────')
  console.log(
    `文件 ${r.profile.files} / 活块 ${r.profile.blocks} / 语料 ${(r.profile.vaultBytes / 1024 / 1024).toFixed(1)} MiB / 目录 ${r.profile.dirs}`,
  )
  console.log('分阶段：')
  for (const p of r.phases) {
    console.log(`  ${p.name.padEnd(24)} ${fmtMs(p.ms).padStart(10)}${p.note ? `   ${p.note}` : ''}`)
  }
  if (r.reconcile) {
    console.log(
      `  ${'per_file'.padEnd(24)} ${fmtMs(r.reconcile.durationMs / Math.max(1, r.reconcile.created)).padStart(10)}   created=${r.reconcile.created}`,
    )
  }
  console.log(`吞吐：${r.filesPerSec.toFixed(1)} files/s（按 reconcileVault 自计时长）`)
  console.log(
    `探针：listVaultFiles ${r.probes.listVaultFilesMs.toFixed(1)}ms / buildVaultFileIndex ${r.probes.buildVaultFileIndexMs.toFixed(1)}ms / ` +
      `unresolvedLookup ${r.probes.unresolvedLookupMs.toFixed(2)}ms / 规模下 ingest ${r.probes.scaleIngestMs.toFixed(1)}ms/篇`,
  )
  console.log(
    `内存（25ms 采样）：peak RSS ${r.memory.peakRssMb.toFixed(0)} MiB / peak heapUsed ${r.memory.peakHeapMb.toFixed(0)} MiB / 结束时 RSS ${r.memory.rssAtStopMb.toFixed(0)} MiB`,
  )
  console.log(
    `变更→可搜：median ${Number.isNaN(r.latency.medianMs) ? 'n/a' : `${r.latency.medianMs.toFixed(0)}ms`}（预算 stabilityMs+200 = ${r.latency.budgetMs}ms）`,
  )
  if (r.latency.samples.length > 0) {
    const dropped = r.latency.samples.filter((s) => s.recoveredByReconcile).length
    console.log(
      `  逐次：${r.latency.samples.map((s) => (Number.isNaN(s.ms) ? '超时' : `${s.ms.toFixed(0)}ms`)).join(', ')}` +
        `（轮询 ${r.latency.samples[0]!.pollAvgMs.toFixed(2)}ms/次，lexicalSearch 复核 ${r.latency.samples.every((s) => s.confirmed) ? '全部命中' : '有未命中'}${dropped > 0 ? `，${dropped} 次 watcher 丢事件` : ''}）`,
    )
  }
  if (r.latency.warmupMs.length > 0) {
    console.log(
      `  预热（含 watcher 冷启动，不计入）：${r.latency.warmupMs.map((m) => (Number.isNaN(m) ? '超时' : `${m.toFixed(0)}ms`)).join(', ')}`,
    )
  }
  console.log(`审计日志：抑制 ${r.suppressedLogLines} 行 console 输出（仍写入 app_logs）`)
  console.log('目标：')
  if (r.targets.reconcile1000 !== null) {
    console.log(
      `  1000 文件首次对账 < 30s        ${fmtMs(r.reconcile?.durationMs ?? 0).padStart(9)}   ${r.targets.reconcile1000 ? 'PASS' : 'FAIL'}`,
    )
  }
  console.log(
    `  变更→可搜 < stabilityMs+200ms  ${`${Number.isNaN(r.latency.medianMs) ? 'n/a' : `${r.latency.medianMs.toFixed(0)}ms`}`.padStart(9)}   ${r.targets.changeSearchable ? 'PASS' : 'FAIL'}`,
  )
  console.log('──────────────────────────────────────────────────')
}

function writeReport(out: string, report: BenchReport): void {
  const abs = isAbsolute(out) ? out : resolve(process.cwd(), out)
  if (abs === REPO_ROOT || abs.startsWith(`${REPO_ROOT}/`)) {
    console.error(`❌ --out 不能写进仓库（${abs}）；请用 /tmp 下的路径`)
    return
  }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`📄 JSON 报告已写入 ${abs}`)
}

await main()
