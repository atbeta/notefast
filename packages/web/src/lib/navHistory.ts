/**
 * 会话内访问栈（镜像浏览器 history，供顶栏返回/前进按钮读 canBack 与标题）。
 *
 * 真正跳转仍走 React Router `navigate(-1/+1)`，与 WKWebView ⌘[ 同源。
 * 本模块不写 localStorage：刷新后栈重置，和浏览器标签页历史一致。
 */

export type NavKind = 'PUSH' | 'REPLACE' | 'POP'

export type NavLocation = {
  pathname: string
  search: string
}

export type NavEntry = NavLocation & {
  label: string
}

export type NavSnapshot = {
  canBack: boolean
  canForward: boolean
  back: NavEntry | null
  forward: NavEntry | null
  current: NavEntry | null
}

const MAX_ENTRIES = 80
const bus = new EventTarget()
const CHANGED = 'changed'

let stack: NavEntry[] = []
let index = -1

export function navKey(loc: NavLocation): string {
  return `${loc.pathname}${loc.search}`
}

let cachedSnap: NavSnapshot | null = null

function emit() {
  cachedSnap = null
  // 推迟到当前渲染之后：Layout 渲染期会 apply，同步 notify 会让订阅方 setState 报错
  queueMicrotask(() => bus.dispatchEvent(new Event(CHANGED)))
}

function capStack() {
  if (stack.length <= MAX_ENTRIES) return
  const drop = stack.length - MAX_ENTRIES
  stack = stack.slice(drop)
  index = Math.max(0, index - drop)
}

export function subscribeNavHistory(fn: () => void): () => void {
  bus.addEventListener(CHANGED, fn)
  return () => bus.removeEventListener(CHANGED, fn)
}

export function navHistorySnapshot(): NavSnapshot {
  if (cachedSnap) return cachedSnap
  cachedSnap = {
    canBack: index > 0,
    canForward: index >= 0 && index < stack.length - 1,
    back: index > 0 ? stack[index - 1]! : null,
    forward: index >= 0 && index < stack.length - 1 ? stack[index + 1]! : null,
    current: index >= 0 ? stack[index]! : null,
  }
  return cachedSnap
}

/** 文档页标题到达后回填当前条目（不新增历史） */
export function setCurrentNavLabel(label: string) {
  const trimmed = label.trim()
  if (!trimmed || index < 0) return
  if (stack[index]!.label === trimmed) return
  stack[index] = { ...stack[index]!, label: trimmed }
  emit()
}

/**
 * 把一次路由变化同步进栈。
 * 首条无论 kind 都播种；之后 PUSH 截断前进栈，POP 在相邻条目间移动，REPLACE 改当前。
 */
export function applyNavLocation(loc: NavLocation, kind: NavKind, label: string): void {
  const entry: NavEntry = {
    pathname: loc.pathname,
    search: loc.search,
    label: label.trim() || loc.pathname,
  }
  const k = navKey(entry)

  if (stack.length === 0) {
    stack = [entry]
    index = 0
    emit()
    return
  }

  if (kind === 'REPLACE') {
    stack[index] = { ...entry, label: entry.label || stack[index]!.label }
    emit()
    return
  }

  if (kind === 'POP') {
    if (navKey(stack[index]!) === k) {
      if (entry.label && stack[index]!.label !== entry.label) {
        stack[index] = { ...stack[index]!, label: entry.label }
        emit()
      }
      return
    }
    if (index > 0 && navKey(stack[index - 1]!) === k) {
      index -= 1
      emit()
      return
    }
    if (index < stack.length - 1 && navKey(stack[index + 1]!) === k) {
      index += 1
      emit()
      return
    }
    const found = stack.findIndex((e) => navKey(e) === k)
    if (found >= 0) {
      index = found
      emit()
      return
    }
    // 未知 POP（少见）：当新条目推进
    stack = stack.slice(0, index + 1)
    stack.push(entry)
    index = stack.length - 1
    capStack()
    emit()
    return
  }

  // PUSH
  if (navKey(stack[index]!) === k) {
    if (entry.label && stack[index]!.label !== entry.label) {
      stack[index] = { ...stack[index]!, label: entry.label }
      emit()
    }
    return
  }
  stack = stack.slice(0, index + 1)
  stack.push(entry)
  index = stack.length - 1
  capStack()
  emit()
}

/** 仅测试用 */
export function _resetNavHistoryForTests() {
  stack = []
  index = -1
  cachedSnap = null
}
