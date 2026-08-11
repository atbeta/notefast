import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Minus, Square, Copy, X } from 'lucide-react'
import { isTauriShell } from '../hooks/useShell'
import { Tooltip } from './ui'

/**
 * 原生壳窗口标题栏（仅 Tauri 家族壳渲染：data-shell = tauri | windows | linux）
 *
 * - 浏览器形态与 macOS 壳不渲染：前者无此概念，后者用系统标题栏（macOS 壳
 *   没有 Tauri window API，误渲染会抛错——所以 gate 在 isTauriShell 且点击前
 *   仍有 __TAURI__ 存在性防御）
 * - 拖拽：data-tauri-drag-region（wry 对 button 等可交互元素自动豁免，点击正常）
 * - 双击空白区域切换最大化（Windows 无边框窗口惯例交互）
 * - 最大化状态经 onResized 事件同步，切换 最大化/还原 图标
 * - 高度 h-9 与 AIChatPanel 的 top-9 下移量保持联动（改这里记得改那边）
 */
export default function TitleBar() {
  const { t } = useTranslation()
  const [maximized, setMaximized] = useState(false)
  const [win, setWin] = useState<TauriWindow | undefined>()

  useEffect(() => {
    if (!isTauriShell()) return
    const w = getTauriWindow()
    if (!w) return
    setWin(w)

    let unlisten: (() => void) | undefined
    let cancelled = false
    const sync = () => {
      w.isMaximized()
        .then((v) => {
          if (!cancelled) setMaximized(v)
        })
        .catch(() => {})
    }
    sync()
    w.onResized(sync)
      .then((u) => {
        if (cancelled) u()
        else unlisten = u
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  if (!win) return null

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        void win.toggleMaximize()
      }}
      className="h-9 shrink-0 flex items-center justify-end pr-1 border-b border-border bg-background select-none"
    >
      {/* 左侧不放应用名：侧栏品牌行已承担身份，标题栏只留拖拽区 + 窗口控制（否则 Tauri 壳左上角重复） */}
      <div className="flex items-center">
        <TitleBarButton label={t('layout.minimize')} onClick={() => void win.minimize()}>
          <Minus className="w-4 h-4" />
        </TitleBarButton>
        <TitleBarButton
          label={maximized ? t('layout.restore') : t('layout.maximize')}
          onClick={() => void win.toggleMaximize()}
        >
          {maximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
        </TitleBarButton>
        <TitleBarButton label={t('layout.closeWindow')} onClick={() => void win.close()} danger>
          <X className="w-4 h-4" />
        </TitleBarButton>
      </div>
    </div>
  )
}

interface TauriWindow {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onResized: (cb: () => void) => Promise<() => void>
}

function getTauriWindow(): TauriWindow | undefined {
  const tauri = (
    window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => TauriWindow } } }
  ).__TAURI__
  return tauri?.window?.getCurrentWindow?.()
}

function TitleBarButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`w-10 h-8 grid place-items-center rounded-md transition-colors ${
          danger
            ? 'text-muted-foreground hover:bg-destructive/15 hover:text-destructive'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}
