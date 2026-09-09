import { api } from './useAPI'
import { useApiQuery } from './useApiQuery'
import type { VaultStatus } from '../lib/vault'

/**
 * vault 状态（`GET /api/v1/vault/status`）。
 * 未启用时服务端回 `{ enabled: false }`（不是 404），请求失败则 data 保持 null——
 * 调用方用 `isVaultEnabled` 判定，两种情况下都隐藏 vault 入口。
 */
export function useVaultStatus() {
  return useApiQuery(() => api.get<VaultStatus>('/vault/status'), [])
}
