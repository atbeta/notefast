/**
 * 选区上报状态机（选区气泡用，与 CodeMirror / DOM 解耦，便于单测）：
 * - schedule(read)：非空选区 debounce 到点后经 read 取锚点上报（read 返回 null 则不上报）；
 *   debounce 窗口内再次 schedule 重置计时（选区持续变化只报最后一次）
 * - clear()：选区清空 / 失焦 / 卸载——取消待报并立即报 null（重复 clear 不重复报）
 */

/** 锚点矩形（viewport 坐标，来自 view.coordsAtPos） */
export interface SelectionRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface SelectionAnchor {
  rect: SelectionRect
  text: string
  from: number
  to: number
}

export const SELECTION_DEBOUNCE_MS = 200

export class SelectionReporter {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastWasNull = true

  constructor(
    private readonly report: (anchor: SelectionAnchor | null) => void,
    private readonly debounceMs: number = SELECTION_DEBOUNCE_MS,
  ) {}

  schedule(read: () => SelectionAnchor | null): void {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      const anchor = read()
      if (!anchor) return
      this.lastWasNull = false
      this.report(anchor)
    }, this.debounceMs)
  }

  clear(): void {
    this.cancelTimer()
    if (this.lastWasNull) return
    this.lastWasNull = true
    this.report(null)
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
