/**
 * 手动检查 GitHub Releases（仅用户点击触发，启动不联网）。
 * 有新版只返回下载链接，不自动安装。
 */

export const RELEASES_API =
  'https://api.github.com/repos/atbeta/notefast/releases/latest'
export const RELEASES_PAGE =
  'https://github.com/atbeta/notefast/releases/latest'

export interface ReleaseInfo {
  version: string
  url: string
}

/** 去掉 v 前缀；非法返回 null */
export function normalizeVersion(tag: string): string | null {
  const v = tag.trim().replace(/^v/i, '')
  return v.length > 0 ? v : null
}

function parseParts(v: string): number[] {
  return v.split('.').map((p) => {
    const n = Number.parseInt(p.replace(/[^0-9].*$/, ''), 10)
    return Number.isFinite(n) ? n : 0
  })
}

/** current 是否 ≥ min（对齐 macOS SemVer.isAtLeast 的粗粒度比较） */
export function isAtLeast(current: string, min: string): boolean {
  const a = parseParts(current)
  const b = parseParts(min)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return true
}

export function isNewer(latest: string, current: string): boolean {
  return !isAtLeast(current, latest)
}

export function parseLatestRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as { tag_name?: unknown; html_url?: unknown }
  if (typeof obj.tag_name !== 'string' || typeof obj.html_url !== 'string') return null
  const version = normalizeVersion(obj.tag_name)
  if (!version) return null
  return { version, url: obj.html_url }
}

export type CheckReleaseResult =
  | { status: 'latest'; current: string }
  | { status: 'update'; current: string; latest: ReleaseInfo }
  | { status: 'error'; message: string }

/** 对照当前版本查 GitHub latest；失败不抛，返回 error 态 */
export async function checkLatestRelease(current: string): Promise<CheckReleaseResult> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      return { status: 'error', message: `HTTP ${res.status}` }
    }
    const info = parseLatestRelease(await res.json())
    if (!info) return { status: 'error', message: 'malformed' }
    if (isNewer(info.version, current)) {
      return { status: 'update', current, latest: info }
    }
    return { status: 'latest', current }
  } catch (e) {
    return {
      status: 'error',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}
