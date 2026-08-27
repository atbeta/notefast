import { describe, test, expect } from 'bun:test'
import {
  docExportPdfPath,
  hasExportPdfParam,
  stripExportPdfParam,
} from '../printDoc'

describe('export pdf 路径', () => {
  test('拼文档页深链', () => {
    expect(docExportPdfPath('abc')).toBe('/doc/abc?export=pdf')
  })

  test('识别并剥掉 export=pdf，保留其它参数', () => {
    const params = new URLSearchParams('export=pdf&edit=1')
    expect(hasExportPdfParam(params)).toBe(true)
    const stripped = stripExportPdfParam(params)
    expect(hasExportPdfParam(stripped)).toBe(false)
    expect(stripped.get('edit')).toBe('1')
    expect(params.get('export')).toBe('pdf')
  })
})
