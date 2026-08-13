import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDb, closeDb } from '../db'
import { initAssetStore, MAX_ASSET_BYTES, readAsset } from '../assets/store'
import { saveImportedImage } from '../services/importedImage'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join('/tmp', 'notefast-imported-image-'))
  initDb(testDir)
  initAssetStore(testDir)
})

afterAll(() => {
  closeDb()
  rmSync(testDir, { recursive: true, force: true })
})

describe('saveImportedImage', () => {
  test('image/* 入库，返回 asset:sha', () => {
    const ref = saveImportedImage(PNG, 'image/png')
    expect(ref).toMatch(/^asset:[0-9a-f]{64}$/)
    const id = ref!.slice('asset:'.length)
    expect(readAsset(id)?.meta.mime).toBe('image/png')
  })

  test('非 image/*、空 buffer、超上限均跳过', () => {
    expect(saveImportedImage(PNG, 'application/octet-stream')).toBeNull()
    expect(saveImportedImage(PNG, '')).toBeNull()
    expect(saveImportedImage(Buffer.alloc(0), 'image/png')).toBeNull()
    expect(saveImportedImage(Buffer.alloc(MAX_ASSET_BYTES + 1), 'image/png')).toBeNull()
  })
})
