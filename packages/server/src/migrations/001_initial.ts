import type { Database } from 'bun:sqlite'
import { CURRENT_SCHEMA_VERSION } from '@notefast/core'

export const id = '001_initial'
export const description = 'Baseline schema (squashed from 001–010)'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      icon        TEXT DEFAULT '',
      sort        INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id            TEXT PRIMARY KEY,
      notebook_id   TEXT NOT NULL,
      parent_id     TEXT,
      root_id       TEXT NOT NULL,
      type          TEXT NOT NULL,
      content       TEXT DEFAULT '',
      content_hash  TEXT,
      properties    TEXT DEFAULT '{}',
      tags          TEXT NOT NULL DEFAULT '[]',
      status        TEXT NOT NULL DEFAULT 'note',
      ai_exclude    INTEGER NOT NULL DEFAULT 0,
      is_deleted    INTEGER NOT NULL DEFAULT 0,
      delete_id     TEXT,
      sort          INTEGER DEFAULT 0,
      level         INTEGER DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (root_id) REFERENCES blocks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_root ON blocks(root_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_notebook ON blocks(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(type);
    CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status);
    CREATE INDEX IF NOT EXISTS idx_blocks_ai_exclude ON blocks(ai_exclude);
    CREATE INDEX IF NOT EXISTS idx_blocks_content_hash ON blocks(content_hash);
    CREATE INDEX IF NOT EXISTS idx_blocks_is_deleted ON blocks(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_blocks_is_deleted_date ON blocks(is_deleted, updated_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
      id UNINDEXED,
      content,
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS block_vectors (
      block_id  TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      dim       INTEGER NOT NULL,
      embedding_model TEXT,
      content_hash TEXT,
      source_content_hash TEXT,
      index_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_block_vectors_dim ON block_vectors(dim);

    CREATE TABLE IF NOT EXISTS vector_store_state (
      id                 TEXT PRIMARY KEY CHECK (id = 'default'),
      active_backend     TEXT NOT NULL DEFAULT 'json',
      status             TEXT NOT NULL DEFAULT 'stale',
      model_fingerprint  TEXT,
      dimension          INTEGER,
      active_generation  TEXT,
      staging_generation TEXT,
      indexed_count      INTEGER NOT NULL DEFAULT 0,
      error              TEXT,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO vector_store_state (id) VALUES ('default');

    CREATE TABLE IF NOT EXISTS vector_generations (
      id                TEXT PRIMARY KEY,
      table_name        TEXT NOT NULL UNIQUE,
      model_fingerprint TEXT NOT NULL,
      dimension         INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'staging',
      indexed_count     INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vector_entries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      generation       TEXT NOT NULL,
      block_id         TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      source_content_hash TEXT,
      notebook_id      TEXT NOT NULL,
      root_id          TEXT NOT NULL,
      block_updated_at TEXT NOT NULL,
      UNIQUE (generation, block_id),
      FOREIGN KEY (generation) REFERENCES vector_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vector_entries_generation ON vector_entries(generation);
    CREATE INDEX IF NOT EXISTS idx_vector_entries_block ON vector_entries(block_id);

    CREATE TABLE IF NOT EXISTS block_refs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      ref_type    TEXT DEFAULT 'link',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (source_id) REFERENCES blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES blocks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_refs_source ON block_refs(source_id);
    CREATE INDEX IF NOT EXISTS idx_refs_target ON block_refs(target_id);

    CREATE TABLE IF NOT EXISTS api_tokens (
      token_id     TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      token_hash   TEXT NOT NULL,
      scopes       TEXT NOT NULL DEFAULT '["read","write"]',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_revoked ON api_tokens(revoked);

    CREATE TABLE IF NOT EXISTS pinned_views (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      query      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS assets (
      id          TEXT PRIMARY KEY,
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 图片理解：asset sha256 → 视觉模型生成的描述（供向量索引拼接；模型变化后重索引自然刷新）
    CREATE TABLE IF NOT EXISTS asset_captions (
      id          TEXT PRIMARY KEY,
      caption     TEXT NOT NULL,
      model       TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 变更馈送（change feed）：同步协议的地基。
    -- seq 单调递增，是客户端增量拉取的游标（不用 updated_at 做游标：
    -- 客户端 push 可自带 updated_at，时钟偏慢会导致变更漏拉）。
    -- updated_at 仅用于 LWW 裁决与「最近编辑」展示语义。
    -- 清理策略待同步 API 落地时定（超出窗口的客户端走全量快照重同步）。
    CREATE TABLE IF NOT EXISTS entity_changes (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      entity     TEXT NOT NULL,
      entity_id  TEXT NOT NULL,
      is_erased  INTEGER NOT NULL DEFAULT 0,
      actor      TEXT NOT NULL DEFAULT 'server',
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_entity_changes_entity ON entity_changes(entity, entity_id);

    -- 分享：doc_id → 公开 token。独立表而非 blocks.properties：
    -- 开关分享不触发 updated_at / hooks / 索引 / change feed。
    -- expires_at NULL = 永不过期
    CREATE TABLE IF NOT EXISTS shares (
      doc_id     TEXT PRIMARY KEY,
      token      TEXT NOT NULL UNIQUE,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);

    -- 图谱实体层：block→entity 提及边（与 block_refs 并列的第二类边）。
    -- name 为规范化名（trim→lowercase→去首尾标点→压缩空白），display 为首个 surface 写法；
    -- mention_count 冗余计数（列表排序 / 归零清理）。软删除不走 FK，由 store 层显式级联。
    CREATE TABLE IF NOT EXISTS entities (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      display       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

    CREATE TABLE IF NOT EXISTS entity_mentions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      block_id   TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
      surface    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_id, block_id)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_block ON entity_mentions(block_id);

    -- 登录审计：记录每次密码登录的时间/IP/UA
    CREATE TABLE IF NOT EXISTS auth_events (
      id          TEXT PRIMARY KEY,
      event_type  TEXT NOT NULL DEFAULT 'login',
      ip          TEXT,
      user_agent  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at DESC);
  `)

  // triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS blocks_fts_insert AFTER INSERT ON blocks
    BEGIN
      INSERT INTO blocks_fts (id, content) VALUES (NEW.id, NEW.content);
    END;

    CREATE TRIGGER IF NOT EXISTS blocks_fts_update AFTER UPDATE ON blocks
    BEGIN
      UPDATE blocks_fts SET content = NEW.content WHERE id = OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS blocks_fts_delete AFTER DELETE ON blocks
    BEGIN
      DELETE FROM blocks_fts WHERE id = OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_blocks_ai AFTER INSERT ON blocks
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, actor)
      VALUES ('block', NEW.id, 'server');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_blocks_au AFTER UPDATE ON blocks
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, is_erased, actor)
      VALUES ('block', NEW.id,
        CASE WHEN OLD.is_deleted = 0 AND NEW.is_deleted = 1 THEN 1 ELSE 0 END,
        'server');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_blocks_ad AFTER DELETE ON blocks
    BEGIN
      INSERT INTO entity_changes (entity, entity_id, is_erased, actor)
      VALUES ('block', OLD.id, 1, 'server');
    END;
  `)

  migrateVectorColumns(db)

  db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`)
}

function migrateVectorColumns(database: Database): void {
  const columns = database.query('PRAGMA table_info(block_vectors)').all() as Array<{ name: string }>
  const names = new Set(columns.map((c) => c.name))
  const additions = [
    ['embedding_model', 'TEXT'],
    ['content_hash', 'TEXT'],
    ['index_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
  ] as const

  for (const [name, type] of additions) {
    if (!names.has(name)) {
      database.exec(`ALTER TABLE block_vectors ADD COLUMN ${name} ${type}`)
    }
  }
  database.exec("UPDATE block_vectors SET updated_at = created_at WHERE updated_at = ''")
}
