/**
 * 图床手动上传是否可用（命令非空，与是否自动上传无关）
 *
 * 与 useAiCapabilities 同形：单例 + useSyncExternalStore。
 * 未配置命令时资源页 / 阅读态不应露出「上传到图床」入口（点了必 400）。
 */

import { useSyncExternalStore } from 'react'
import { hasImageUploadCommand } from '@notefast/core'
import { api } from './useAPI'

export type ImageUploadEnabledSnapshot = {
  /** 可触发手动上传（设置页已填图床命令） */
  enabled: boolean
  /** 首探完成（失败也算 ready，按未启用处理） */
  ready: boolean
}

const SERVER_SNAPSHOT: ImageUploadEnabledSnapshot = { enabled: false, ready: false }

let snapshot: ImageUploadEnabledSnapshot = SERVER_SNAPSHOT
let mounted = 0
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

/** 与服务端 uploadSingleAsset / upload-missing 门槛对齐（只看命令） */
export function isImageUploadConfigured(cfg: { mode?: string; command?: string }): boolean {
  return hasImageUploadCommand(cfg)
}

async function fetchConfig(): Promise<void> {
  try {
    const cfg = await api.get<{ mode: string; command: string }>('/assets/upload-config')
    snapshot = { enabled: isImageUploadConfigured(cfg), ready: true }
  } catch {
    snapshot = { enabled: false, ready: true }
  }
  emit()
}

function ensureFetch(): void {
  if (!snapshot.ready && mounted > 0) void fetchConfig()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  mounted++
  ensureFetch()
  return () => {
    listeners.delete(listener)
    mounted--
  }
}

function getSnapshot(): ImageUploadEnabledSnapshot {
  return snapshot
}

function getServerSnapshot(): ImageUploadEnabledSnapshot {
  return SERVER_SNAPSHOT
}

export function useImageUploadEnabled(): ImageUploadEnabledSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** 设置页保存后强制重探，让资源页 / 阅读态立刻显隐上传入口 */
export function refreshImageUploadEnabled(): void {
  snapshot = { enabled: false, ready: false }
  emit()
  void fetchConfig()
}
