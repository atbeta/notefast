import { describe, test, expect } from 'bun:test'
import { SelectionReporter } from '../selectionReport'
import type { SelectionAnchor } from '../selectionReport'

const anchor: SelectionAnchor = {
  rect: { left: 10, top: 20, right: 30, bottom: 40 },
  text: '选区',
  from: 0,
  to: 2,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('SelectionReporter（选区上报）', () => {
  test('非空选区 debounce 后上报锚点', async () => {
    const reports: Array<SelectionAnchor | null> = []
    const r = new SelectionReporter((a) => reports.push(a), 20)
    r.schedule(() => anchor)
    expect(reports).toHaveLength(0)
    await sleep(50)
    expect(reports).toEqual([anchor])
  })

  test('debounce 窗口内再次变化重置计时，只报最后一次', async () => {
    const reports: Array<SelectionAnchor | null> = []
    const r = new SelectionReporter((a) => reports.push(a), 30)
    const other: SelectionAnchor = { ...anchor, text: '变化后', to: 3 }
    r.schedule(() => anchor)
    await sleep(10)
    r.schedule(() => other)
    await sleep(60)
    expect(reports).toEqual([other])
  })

  test('清空立即报 null 并取消待报锚点', async () => {
    const reports: Array<SelectionAnchor | null> = []
    const r = new SelectionReporter((a) => reports.push(a), 20)
    r.schedule(() => anchor)
    await sleep(40) // 已上报 anchor（气泡显示中）
    const other: SelectionAnchor = { ...anchor, text: '新选区', to: 3 }
    r.schedule(() => other)
    r.clear() // 清空：立即报 null，待报的 other 被取消
    await sleep(40)
    expect(reports).toEqual([anchor, null])
  })

  test('失焦报 null；重复 clear 不重复报', async () => {
    const reports: Array<SelectionAnchor | null> = []
    const r = new SelectionReporter((a) => reports.push(a), 20)
    r.schedule(() => anchor)
    await sleep(40)
    r.clear() // 失焦
    r.clear() // 重复清空（如卸载兜底）不重复报
    expect(reports).toEqual([anchor, null])
  })

  test('到点时 read 返回 null（已失焦/选区消失/纯空白选区）则不上报', async () => {
    const reports: Array<SelectionAnchor | null> = []
    const r = new SelectionReporter((a) => reports.push(a), 20)
    r.schedule(() => null)
    await sleep(40)
    expect(reports).toHaveLength(0)
  })
})
