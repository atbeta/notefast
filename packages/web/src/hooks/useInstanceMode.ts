/**
 * 实例模式（RFC 0005 U-1）：`GET /api/v1/instance` 的 `mode` / `vault_root`。
 *
 * 侧栏要按模式分支（vault 模式显示文件夹树），所以这里必须能在任意页面拿到——
 * 比 `/vault/status` 更合适：db 模式下它也返回 200（`mode: 'db'`），不用靠 404 推断。
 * 旧服务端没有这两个字段时 `mode` 为 null，调用方按 db 模式处理。
 */

import { api } from './useAPI'
import { useApiQuery } from './useApiQuery'

export interface InstanceMode {
  mode: 'db' | 'vault' | null
  vault_root: string | null
}

interface InstanceResponse {
  mode?: 'db' | 'vault'
  vault_root?: string | null
}

export function useInstanceMode(): InstanceMode {
  const { data } = useApiQuery<InstanceResponse>(() => api.get<InstanceResponse>('/instance'), [])
  return {
    mode: data?.mode ?? null,
    vault_root: data?.vault_root ?? null,
  }
}
