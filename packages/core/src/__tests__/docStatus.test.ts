import { describe, expect, test } from 'bun:test'
import {
  isInboxDoc,
  parseDocStatusFilter,
  readDocStatusFromProperties,
  setDocStatusInProperties,
} from '../docStatus'

describe('docStatus', () => {
  test('缺省为 note', () => {
    expect(readDocStatusFromProperties('{}')).toBe('note')
    expect(isInboxDoc('{}')).toBe(false)
  })

  test('读写 inbox', () => {
    const on = setDocStatusInProperties('{"tags":["a"]}', 'inbox')
    expect(JSON.parse(on)).toEqual({ tags: ['a'], status: 'inbox' })
    expect(isInboxDoc(on)).toBe(true)
    const off = setDocStatusInProperties(on, 'note')
    expect(JSON.parse(off)).toEqual({ tags: ['a'] })
  })

  test('parseDocStatusFilter 默认 note', () => {
    expect(parseDocStatusFilter(undefined)).toBe('note')
    expect(parseDocStatusFilter('inbox')).toBe('inbox')
    expect(parseDocStatusFilter('all')).toBe('all')
  })
})
