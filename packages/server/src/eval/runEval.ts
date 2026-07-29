/**
 * 检索评测运行器（bun 脚本，非测试）
 *
 * 用法：
 *   bun --filter @notefast/server eval --mock \
 *     --corpus packages/server/src/eval/fixtures/corpus.json \
 *     --queries packages/server/src/eval/fixtures/queries.json
 *
 * 参数：
 *   --corpus <path>   语料 JSON（必填）
 *   --queries <path>  查询 JSON（必填）
 *   --mock            确定性 mock embedding（CI 用，只验证管线接线）
 *   --config <path>   活体模式的 ai.config.json（默认 $DATA_DIR/ai.config.json 或 ./data/ai.config.json）
 *   --report <path>   报告 JSON 输出路径（默认只打 console 摘要）
 *   --topk <n>        hybridSearch topK（默认 20，需 ≥ Block Recall 的 K）
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  setupEvalEnv,
  seedCorpus,
  buildEvalIndex,
  runEvalQueries,
  computeMetrics,
  formatSummary,
  type CorpusFile,
  type QueriesFile,
} from './evalCore'

/** 仓库根目录（本文件在 packages/server/src/eval/ 下） */
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

/**
 * 输入路径解析：bun --filter 会把 cwd 切到包目录，而用户可能在仓库根敲命令。
 * 相对路径先试 cwd，找不到再试仓库根；输出路径不做存在性回退（直接按 cwd）。
 */
function resolveInput(p: string): string {
  if (isAbsolute(p)) return p
  const fromCwd = resolve(process.cwd(), p)
  if (existsSync(fromCwd)) return fromCwd
  return resolve(REPO_ROOT, p)
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const corpusPath = args.corpus ? resolveInput(String(args.corpus)) : null
  const queriesPath = args.queries ? resolveInput(String(args.queries)) : null
  if (!corpusPath || !queriesPath) {
    console.error('用法: bun run src/eval/runEval.ts --corpus <path> --queries <path> [--mock] [--config <path>] [--report <out.json>] [--topk 20]')
    process.exit(1)
  }
  const mock = args.mock === true
  const topk = args.topk ? parseInt(String(args.topk), 10) : 20
  const reportPath = args.report
    ? (isAbsolute(String(args.report)) ? String(args.report) : resolve(REPO_ROOT, String(args.report)))
    : null
  const configPath = args.config
    ? resolveInput(String(args.config))
    : join(process.env.DATA_DIR || './data', 'ai.config.json')

  const corpus = (await Bun.file(corpusPath).json()) as CorpusFile
  const queriesFile = (await Bun.file(queriesPath).json()) as QueriesFile
  console.log(`📦 语料 ${corpus.docs.length} 篇 / 查询 ${queriesFile.queries.length} 条 / 模式: ${mock ? 'mock' : 'live'}`)

  const env = await setupEvalEnv({ mock, configPath: mock ? undefined : configPath })
  try {
    const titleToDocId = seedCorpus(corpus.docs, env.notebookId)
    if (env.hasEmbedding) {
      const r = await buildEvalIndex(env.notebookId)
      console.log(`🧠 向量索引：indexed=${r?.indexed ?? 0} errors=${r?.errors ?? 0}`)
    } else {
      console.warn('⚠️  无 embedding：语义通道关闭，退化为纯 FTS 评测')
    }

    const results = await runEvalQueries(queriesFile.queries, { topK: topk })
    const report = computeMetrics(queriesFile.queries, results, titleToDocId, {
      mode: mock ? 'mock' : 'live',
      corpusDocs: corpus.docs.length,
      topk,
    })

    console.log(formatSummary(report))

    if (reportPath) {
      mkdirSync(dirname(reportPath), { recursive: true })
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8')
      console.log(`📄 报告已写入 ${reportPath}`)
    }
  } finally {
    env.cleanup()
  }
}

await main()
