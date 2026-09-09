/**
 * MCP 工具 —— vault mode 状态与对账
 *
 * notefast_vault_status / notefast_vault_rebuild：让 AI 消费方知道「这篇库来自哪个文件夹、
 * 文件数、上次对账结果」，并在文件被外部批量改动后主动重建索引（RFC 0001 D3）。
 * 未启用 vault 时返回 enabled:false，不报错墙（AGENTS「零配置优雅降级」）。
 */

import { getActiveVaultRuntime } from '../../vault'
import { toText, toolError, type ToolContext } from './helpers'

export function registerVaultTools(ctx: ToolContext): void {
  const { registerTool } = ctx

  registerTool(
    'notefast_vault_status',
    {
      annotations: { readOnlyHint: true },
      description:
        'vault 模式状态：根目录、文件数、是否监听 / 写回、上次对账统计、最近写回冲突。未启用 vault 时返回 enabled=false。',
      inputSchema: {},
    },
    async () => {
      const runtime = getActiveVaultRuntime()
      if (!runtime) {
        return { content: [toText({ enabled: false, hint: '当前实例未配置 VAULT_PATH，运行在 db notebook 模式' })] }
      }
      return { content: [toText(runtime.status())] }
    },
  )

  registerTool(
    'notefast_vault_rebuild',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        '让 SQLite 索引与磁盘对齐：磁盘新增 / 改动 → ingest，消失 → 按 sha 配对改名或进回收站。外部工具（Obsidian / git / Syncthing）批量改动文件后调用。未启用 vault 时报错。',
      inputSchema: {},
    },
    async () => {
      const runtime = getActiveVaultRuntime()
      if (!runtime) {
        return toolError('invalid_params', '当前实例未启用 vault 模式（未配置 VAULT_PATH）')
      }
      const stats = await runtime.rebuild()
      return { content: [toText(stats)] }
    },
  )
}
