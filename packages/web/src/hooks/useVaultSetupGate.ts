/**
 * 「vault 是唯一形态」引导的判定（RFC 0006）
 *
 * 只有 db 模式才需要引导：vault 模式什么都不显示。
 * db 模式下区分两种情形，文案不同（见 `VaultSetupNotice`）：
 * - 库里有文档 → 0.90 之前的旧库，给「导出 + 迁移三步」
 * - 库是空的 → 新装还没指定文件夹，给「各部署方式怎么指定」
 *
 * 「暂时继续用数据库模式」记在 localStorage：Docker 没有挂载文件夹的人不该被反复挡住。
 */
import { useCallback, useState } from 'react'
import { api } from './useAPI'
import { useApiQuery } from './useApiQuery'

const DISMISS_KEY = 'notefast.vault-setup-dismissed'

interface InstanceView {
  mode?: 'db' | 'vault'
  vault_root?: string | null
  db_doc_count?: number
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export interface VaultSetupGate {
  /** 需要显示引导页时非空 */
  docCount: number | null
  dismiss: () => void
}

export function useVaultSetupGate(enabled = true): VaultSetupGate {
  const { data } = useApiQuery<InstanceView>(
    () => (enabled ? api.get<InstanceView>('/instance') : Promise.resolve({})),
    [enabled],
  )
  const [dismissed, setDismissed] = useState(readDismissed)

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* 隐私模式：本次会话内仍生效 */
    }
    setDismissed(true)
  }, [])

  if (!enabled || dismissed) return { docCount: null, dismiss }
  if (data?.mode !== 'db') return { docCount: null, dismiss }
  return { docCount: data.db_doc_count ?? 0, dismiss }
}
