/**
 * CJK 子串倒排：连续汉字滑动 bigram。
 *
 * unicode61 不切 CJK；FTS5 trigram 有 2 字死区。检索用本表缩小候选，
 * 再 LIKE 校验精确子串，避免对全部活块做 '%词%' 全表扫描。
 *
 * bun:sqlite 无 UDF，触发器用预生成的偏移表 + unicode() 判断汉字。
 * 单块只索引前 {@link CJK_NGRAM_MAX_CHARS} 字（远超常见块长）。
 */
import type { Database } from 'bun:sqlite'

export const CJK_CHAR_RE = /[一-鿿]/

/** CJK Unified Ideographs：U+4E00–U+9FFF（与 CJK_CHAR_RE / 一-鿿 一致） */
const CJK_CP_MIN = 0x4e00
const CJK_CP_MAX = 0x9fff

/** 单块参与 bigram 的最大字符数（偏移表行数） */
export const CJK_NGRAM_MAX_CHARS = 65536

/** 查询侧单 variant 最多用多少个 bigram 做 INTERSECT（索引仍存全量） */
const MAX_QUERY_GRAMS = 32

const CJK_PAIR_SQL = (contentExpr: string, offsetAlias = 'o') => `
  unicode(substr(${contentExpr}, ${offsetAlias}.i, 1)) BETWEEN ${CJK_CP_MIN} AND ${CJK_CP_MAX}
  AND unicode(substr(${contentExpr}, ${offsetAlias}.i + 1, 1)) BETWEEN ${CJK_CP_MIN} AND ${CJK_CP_MAX}
`

const TRIGGERS = `
  CREATE TRIGGER block_cjk_grams_insert AFTER INSERT ON blocks
  BEGIN
    INSERT OR IGNORE INTO block_cjk_grams (gram, block_id)
    SELECT substr(NEW.content, o.i, 2), NEW.id
    FROM cjk_gram_offsets o
    WHERE o.i < length(NEW.content)
      AND ${CJK_PAIR_SQL('NEW.content')};
  END;

  CREATE TRIGGER block_cjk_grams_update AFTER UPDATE OF content ON blocks
  BEGIN
    DELETE FROM block_cjk_grams WHERE block_id = OLD.id;
    INSERT OR IGNORE INTO block_cjk_grams (gram, block_id)
    SELECT substr(NEW.content, o.i, 2), NEW.id
    FROM cjk_gram_offsets o
    WHERE o.i < length(NEW.content)
      AND ${CJK_PAIR_SQL('NEW.content')};
  END;

  CREATE TRIGGER block_cjk_grams_delete AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_cjk_grams WHERE block_id = OLD.id;
  END;
`

/** 连续汉字滑动 2-gram（段内去重保序） */
export function extractCjkBigrams(text: string): string[] {
  const grams: string[] = []
  const seen = new Set<string>()
  const add = (gram: string) => {
    if (seen.has(gram)) return
    seen.add(gram)
    grams.push(gram)
  }
  let run = ''
  const flush = () => {
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i++) add(run.slice(i, i + 2))
    }
    run = ''
  }
  const limit = Math.min(text.length, CJK_NGRAM_MAX_CHARS)
  for (let i = 0; i < limit; i++) {
    const ch = text[i]!
    if (CJK_CHAR_RE.test(ch)) run += ch
    else flush()
  }
  flush()
  return grams
}

export function ensureCjkNgramTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS block_cjk_grams (
      gram TEXT NOT NULL,
      block_id TEXT NOT NULL,
      PRIMARY KEY (gram, block_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_block_cjk_grams_block ON block_cjk_grams(block_id);
    CREATE TABLE IF NOT EXISTS cjk_gram_offsets (
      i INTEGER PRIMARY KEY
    );
  `)
  const n = (db.query('SELECT count(*) AS c FROM cjk_gram_offsets').get() as { c: number }).c
  if (n >= CJK_NGRAM_MAX_CHARS) return
  db.exec('DELETE FROM cjk_gram_offsets')
  const insert = db.query('INSERT INTO cjk_gram_offsets (i) VALUES (?)')
  const fill = db.transaction(() => {
    for (let i = 1; i <= CJK_NGRAM_MAX_CHARS; i++) insert.run(i)
  })
  fill()
}

function installCjkNgramTriggers(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS block_cjk_grams_insert;
    DROP TRIGGER IF EXISTS block_cjk_grams_update;
    DROP TRIGGER IF EXISTS block_cjk_grams_delete;
  `)
  db.exec(TRIGGERS)
}

/** 建表 + 从 blocks 回填 + 安装触发器 */
export function rebuildCjkNgrams(db: Database): void {
  ensureCjkNgramTable(db)
  db.exec(`
    DROP TRIGGER IF EXISTS block_cjk_grams_insert;
    DROP TRIGGER IF EXISTS block_cjk_grams_update;
    DROP TRIGGER IF EXISTS block_cjk_grams_delete;
  `)
  db.exec('DELETE FROM block_cjk_grams')
  db.exec(`
    INSERT OR IGNORE INTO block_cjk_grams (gram, block_id)
    SELECT substr(b.content, o.i, 2), b.id
    FROM blocks b
    JOIN cjk_gram_offsets o ON o.i < length(b.content)
    WHERE ${CJK_PAIR_SQL('b.content')}
  `)
  installCjkNgramTriggers(db)
}

/**
 * LIKE 路候选预过滤（挂在 `b.id` 上的 EXISTS 子句）。
 *
 * formGroups：已展开的组内形态（含半角/全角标点）。
 * - AND：只约束纯 CJK 组；ASCII 组留给 LIKE。
 * - OR：任一形态切不出 bigram 则放弃（否则会漏掉只命中 ASCII 组的块）。
 * 返回 `{ sql, params }` 用在 `AND (${sql})`；null = 不预过滤。
 */
export function cjkNgramPrefilter(
  formGroups: string[][],
  orMode: boolean,
): { sql: string; params: string[] } | null {
  const groupClauses: { sql: string; params: string[] }[] = []

  for (const forms of formGroups) {
    const variantClauses: { sql: string; params: string[] }[] = []
    let hasNonCjk = false
    for (const form of forms) {
      const grams = extractCjkBigrams(form).slice(0, MAX_QUERY_GRAMS)
      if (grams.length === 0) {
        hasNonCjk = true
        continue
      }
      variantClauses.push({
        sql: grams
          .map(() => 'EXISTS (SELECT 1 FROM block_cjk_grams g WHERE g.block_id = b.id AND g.gram = ?)')
          .join(' AND '),
        params: grams,
      })
    }
    if (hasNonCjk) {
      if (orMode) return null
      continue
    }
    if (variantClauses.length === 0) {
      if (orMode) return null
      continue
    }
    groupClauses.push({
      sql: variantClauses.map((v) => `(${v.sql})`).join(' OR '),
      params: variantClauses.flatMap((v) => v.params),
    })
  }

  if (groupClauses.length === 0) return null
  const joiner = orMode ? ' OR ' : ' AND '
  return {
    sql: groupClauses.map((g) => `(${g.sql})`).join(joiner),
    params: groupClauses.flatMap((g) => g.params),
  }
}
