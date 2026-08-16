/**
 * 改写流式原地替换会话（与 React 解耦，便于单测）。
 *
 * 记录替换锚点 from 与替换终点 end（初始为原选区 to）：首个 token 把原选区
 * [from, to) 替换掉，之后每个 token 把 [from, from + 已插入长度) 渐进替换为
 * 累积全文（undo 经 history newGroupDelay 合并为 1~2 步）。
 *
 * 流式期间的外部编辑判定：apply 内的 replace 会同步触发编辑器 onChange，
 * 此刻 isExternalEdit() 为 false；其余时刻（token 间隙的用户输入等）为 true，
 * 调用方应取消流并保留已替换内容（ghost dismiss-on-input 同款先例）。
 */
export class RefineSession {
  /** 下一次替换的终点：首次为原选区 to，之后为 from + 已插入文本长度 */
  private end: number
  private applying = false

  constructor(
    readonly from: number,
    to: number,
    private readonly replace: (from: number, to: number, text: string) => void,
  ) {
    this.end = to
  }

  /** 应用一个累积快照（改写全文），同步 dispatch */
  apply(accumulated: string): void {
    this.applying = true
    try {
      this.replace(this.from, this.end, accumulated)
      this.end = this.from + accumulated.length
    } finally {
      this.applying = false
    }
  }

  /** 流式期间的文档变更是否来自外部（非本次会话的 apply） */
  isExternalEdit(): boolean {
    return !this.applying
  }
}
