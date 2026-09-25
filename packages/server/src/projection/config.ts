/**
 * 投影文件夹的监听配置。
 *
 * 只保留 watcher 真正需要的字段；vault 的 `VAULT_*` 环境变量在这里叫 `PROJECTION_*`。
 * 注意 `usePolling` 只是**兜底值**：真正生效的后端由启动探测决定（见 watchProbe.ts），
 * 探测结论会覆盖它。
 */

export interface ProjectionConfig {
  /** 被监听的文件夹绝对路径 */
  root: string
  /** 额外的忽略前缀（相对路径整段匹配） */
  ignore: string[]
  /** 是否监听（false = 只在启动时对账一次） */
  watch: boolean
  /** awaitWriteFinish 的稳定窗口：编辑器一次保存会连发多个 fs 事件 */
  stabilityMs: number
  usePolling: boolean
  /**
   * `usePolling` 的来源：`env` = 环境变量显式指定；`auto` = 由运行时探测决定。
   * 区分两者是为了让「用户明确要求轮询」不被探测结论推翻。
   */
  pollingSource: 'auto' | 'env'
  pollIntervalMs: number
}

const DEFAULT_IGNORE: readonly string[] = ['.git', '.obsidian', '.trash', 'node_modules']

function num(raw: string | undefined, fallback: number, min = 0): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function resolveProjectionConfig(
  root: string,
  env: Record<string, string | undefined> = process.env,
): ProjectionConfig {
  const extra = (env.PROJECTION_IGNORE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const pollingEnv = env.PROJECTION_USE_POLLING
  const pollingExplicit = pollingEnv === 'true' || pollingEnv === '1' || pollingEnv === 'false' || pollingEnv === '0'
  return {
    root,
    ignore: [...new Set([...DEFAULT_IGNORE, ...extra])],
    watch: env.PROJECTION_WATCH !== 'false',
    stabilityMs: num(env.PROJECTION_STABILITY_MS, 300),
    usePolling: pollingEnv === 'true' || pollingEnv === '1',
    pollingSource: pollingExplicit ? 'env' : 'auto',
    pollIntervalMs: num(env.PROJECTION_POLL_INTERVAL_MS, 1000, 1),
  }
}
