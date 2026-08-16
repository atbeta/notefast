import { describe, test, expect } from 'bun:test'
import { classifyChatMath } from '@notefast/shared'

/**
 * M1 冒烟测试：验证 editor 包能正确解析 @notefast/shared 的 workspace 依赖，
 * 且 shared 导出的纯函数可被 editor 侧引用（后续 M2 接入编辑器/预览的基础）。
 */
describe('editor ↔ shared 集成', () => {
  test('shared 纯函数可在 editor 包内调用', () => {
    expect(classifyChatMath('language-math')).toBe('display')
    expect(classifyChatMath('language-js')).toBeNull()
  })
})
