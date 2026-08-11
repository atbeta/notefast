import { describe, expect, test } from 'bun:test'
import { NO_AUTOFILL_TOKEN, resolveNoAutofillToken } from '../noAutofill'

describe('resolveNoAutofillToken', () => {
  test('普通文本框 → 非标准 token（Blink 忽略 off）', () => {
    expect(resolveNoAutofillToken('text', null)).toBe(NO_AUTOFILL_TOKEN)
    expect(resolveNoAutofillToken(null, null)).toBe(NO_AUTOFILL_TOKEN)
    expect(resolveNoAutofillToken('text', 'off')).toBe(NO_AUTOFILL_TOKEN)
  })

  test('password 与密码管理器 token 豁免', () => {
    expect(resolveNoAutofillToken('password', null)).toBeNull()
    expect(resolveNoAutofillToken('password', 'current-password')).toBeNull()
    expect(resolveNoAutofillToken('text', 'current-password')).toBeNull()
    expect(resolveNoAutofillToken('text', 'new-password')).toBeNull()
    expect(resolveNoAutofillToken('text', 'username')).toBeNull()
  })
})
