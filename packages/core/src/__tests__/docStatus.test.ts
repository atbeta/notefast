import { describe, expect, test } from 'bun:test'
import {
  isDocInbox,
  parseDocStatusFilter,
  readDocStatus,
} from '../docStatus'
import type { BlockRow } from '../types'

function makeRow(status: string = 'note'): BlockRow {
  return {
    id: 'x', notebook_id: 'nb1', parent_id: null, root_id: 'x',
    type: 'document', content: '', properties: '{}',
    tags: '[]', status, ai_exclude: 0,
    sort: 0, level: 0, created_at: '', updated_at: '',
  }
}

describe('docStatus', () => {
  test('缺省为 note', () => {
    const row = makeRow()
    expect(readDocStatus(row)).toBe('note')
    expect(isDocInbox(row)).toBe(false)
  })

  test('读写 inbox', () => {
    const row = makeRow('inbox')
    expect(readDocStatus(row)).toBe('inbox')
    expect(isDocInbox(row)).toBe(true)
  })

  test('parseDocStatusFilter 默认 note', () => {
    expect(parseDocStatusFilter(undefined)).toBe('note')
    expect(parseDocStatusFilter('inbox')).toBe('inbox')
    expect(parseDocStatusFilter('all')).toBe('all')
  })
})
