import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  configureSqliteForExtensions,
  loadSqliteVec,
} from '../sqliteVec'

configureSqliteForExtensions()
const db = new Database(':memory:')

afterAll(() => db.close())

describe('sqlite-vec 加载 spike', () => {
  test('加载扩展并执行 float32 cosine KNN', () => {
    const version = loadSqliteVec(db)
    expect(version).toMatch(/^v0\.1\./)

    db.exec('CREATE VIRTUAL TABLE vec_spike USING vec0(embedding float[2] distance_metric=cosine)')
    const insert = db.query('INSERT INTO vec_spike(rowid, embedding) VALUES (?, ?)')
    insert.run(1, new Float32Array([1, 0]))
    insert.run(2, new Float32Array([0, 1]))

    const rows = db.query(
      `SELECT rowid, distance FROM vec_spike
       WHERE embedding MATCH ? AND k = 2
       ORDER BY distance`,
    ).all(new Float32Array([1, 0])) as Array<{ rowid: number; distance: number }>

    expect(rows.map((row) => row.rowid)).toEqual([1, 2])
    expect(rows[0]!.distance).toBeCloseTo(0, 5)
    expect(rows[1]!.distance).toBeCloseTo(1, 5)
  })
})
