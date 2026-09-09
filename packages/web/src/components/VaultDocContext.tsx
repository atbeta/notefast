/**
 * 当前阅读的文档是不是 vault 文档，是的话它在 vault 里的相对路径是什么。
 *
 * BlockRenderer 渲染任意层级的块，图片路径解析需要知道文档所在目录（V-303），
 * 逐层传 prop 会污染一堆组件签名，用 context 更合适。
 * 分享页 / db notebook 没有 Provider → 值为 null → 图片路径保持原样。
 */
import { createContext, useContext, type ReactNode } from 'react'

const VaultDocContext = createContext<string | null>(null)

export function VaultDocProvider({
  vaultPath,
  children,
}: {
  vaultPath: string | null
  children: ReactNode
}) {
  return <VaultDocContext.Provider value={vaultPath}>{children}</VaultDocContext.Provider>
}

export function useVaultPath(): string | null {
  return useContext(VaultDocContext)
}
