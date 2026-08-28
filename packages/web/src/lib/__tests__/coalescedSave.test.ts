import { describe, expect, test } from 'bun:test'
import { autoSaveDelayMs, createCoalescedSave } from '../coalescedSave'

describe('autoSaveDelayMs', () => {
  test('短文 3s，中等 8s，长文 15s', () => {
    expect(autoSaveDelayMs('hi')).toBe(3_000)
    expect(autoSaveDelayMs('x'.repeat(20_000))).toBe(8_000)
    expect(autoSaveDelayMs('x'.repeat(80_000))).toBe(15_000)
  })
})

describe('createCoalescedSave', () => {
  test('在途时只保留最新正文，串行一次收尾', async () => {
    const started: string[] = []
    const save = (md: string, ck: boolean) => {
      started.push(`${md}:${ck}`)
      return new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 20)
      })
    }
    const q = createCoalescedSave(save)
    const first = q.flush('a', false)
    q.schedule('b')
    q.schedule('c')
    expect(await first).toBe(true)
    expect(started).toEqual(['a:false', 'c:false'])
  })

  test('pending 期间的 checkpoint 会带到下一次冲刷', async () => {
    const flags: boolean[] = []
    const save = (_md: string, ck: boolean) => {
      flags.push(ck)
      return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 15))
    }
    const q = createCoalescedSave(save)
    const first = q.flush('a', false)
    q.schedule('b', true)
    expect(await first).toBe(true)
    expect(flags).toEqual([false, true])
  })
})
