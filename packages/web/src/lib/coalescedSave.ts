/**
 * 文档保存队列：同一时刻最多一个 PUT 在途；输入继续变化时只保留最新正文。
 * 任一次请求带 checkpoint 则冲刷时也带 checkpoint（离开/⌘S 不能被自动保存吞掉）。
 */

export function autoSaveDelayMs(markdown: string): number {
  const n = markdown.length
  if (n >= 80_000) return 15_000
  if (n >= 20_000) return 8_000
  return 3_000
}

export function createCoalescedSave(
  save: (markdown: string, checkpoint: boolean) => Promise<boolean>,
): {
  schedule: (markdown: string, checkpoint?: boolean) => void
  flush: (markdown: string, checkpoint?: boolean) => Promise<boolean>
} {
  let running = false
  let pending: { markdown: string; checkpoint: boolean } | null = null
  let lastOk = true
  const idleWaiters: Array<() => void> = []

  const merge = (markdown: string, checkpoint: boolean) => {
    pending = {
      markdown,
      checkpoint: Boolean(pending?.checkpoint || checkpoint),
    }
  }

  const pump = async () => {
    if (running) return
    running = true
    try {
      while (pending) {
        const job = pending
        pending = null
        lastOk = await save(job.markdown, job.checkpoint)
      }
    } finally {
      running = false
      if (pending) {
        await pump()
      } else {
        const waiters = idleWaiters.splice(0)
        for (const w of waiters) w()
      }
    }
  }

  return {
    schedule(markdown: string, checkpoint = false) {
      merge(markdown, checkpoint)
      void pump()
    },
    async flush(markdown: string, checkpoint = false) {
      merge(markdown, checkpoint)
      void pump()
      if (running || pending) {
        await new Promise<void>((resolve) => {
          idleWaiters.push(resolve)
        })
      }
      return lastOk
    },
  }
}
