import { describe, expect, test } from 'bun:test'
import {
  isAtLeast,
  isNewer,
  normalizeVersion,
  parseLatestRelease,
} from '../checkRelease'

describe('checkRelease', () => {
  test('normalizeVersion 去 v 前缀', () => {
    expect(normalizeVersion('v0.63.0')).toBe('0.63.0')
    expect(normalizeVersion('0.63.0')).toBe('0.63.0')
    expect(normalizeVersion('')).toBeNull()
  })

  test('isNewer / isAtLeast', () => {
    expect(isNewer('0.64.0', '0.63.0')).toBe(true)
    expect(isNewer('0.63.0', '0.63.0')).toBe(false)
    expect(isNewer('0.62.0', '0.63.0')).toBe(false)
    expect(isAtLeast('0.63.0', '0.63.0')).toBe(true)
    expect(isAtLeast('0.63.1', '0.63.0')).toBe(true)
  })

  test('parseLatestRelease', () => {
    expect(
      parseLatestRelease({
        tag_name: 'v0.64.0',
        html_url: 'https://github.com/atbeta/notefast/releases/tag/v0.64.0',
      }),
    ).toEqual({
      version: '0.64.0',
      url: 'https://github.com/atbeta/notefast/releases/tag/v0.64.0',
    })
    expect(parseLatestRelease({})).toBeNull()
    expect(parseLatestRelease(null)).toBeNull()
  })
})
