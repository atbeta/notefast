import type { Database } from 'bun:sqlite'

export const id = '001_initial'
export const description = 'Initial schema: notebooks, blocks, FTS, block_vectors, assets, autolink, triggers'

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
      id          TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      parent_id   TEXT,
      root_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      content     TEXT DEFAULT '',
      properties  TEXT DEFAULT '{}',
      sort        INTEGER DEFAULT 0,
      level       INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (root_id) REFERENCES blocks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_root ON blocks(root_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_notebook ON blocks(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(type);

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
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      generation   TEXT NOT NULL,
      block_id     TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      notebook_id  TEXT NOT NULL,
      root_id      TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS autolink_suggestions (
      id                    TEXT PRIMARY KEY,
      source_block_id       TEXT NOT NULL,
      source_content_hash   TEXT NOT NULL,
      source_updated_at     TEXT NOT NULL,
      notebook_id           TEXT NOT NULL,
      anchor                TEXT NOT NULL,
      kind                  TEXT NOT NULL,
      candidates            TEXT NOT NULL,
      action_status         TEXT NOT NULL DEFAULT 'suggested',
      review_status         TEXT NOT NULL DEFAULT 'unreviewed',
      created_ref_id        INTEGER,
      applied_target_id     TEXT,
      score_kind            TEXT,
      model                 TEXT,
      error                 TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      applied_at            TEXT,
      reviewed_at           TEXT,
      FOREIGN KEY (created_ref_id) REFERENCES block_refs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_autolink_review ON autolink_suggestions(review_status);
    CREATE INDEX IF NOT EXISTS idx_autolink_action ON autolink_suggestions(action_status);
    CREATE INDEX IF NOT EXISTS idx_autolink_source ON autolink_suggestions(source_block_id);
    CREATE INDEX IF NOT EXISTS idx_autolink_hash   ON autolink_suggestions(source_block_id, source_content_hash);

    CREATE TABLE IF NOT EXISTS assets (
      id          TEXT PRIMARY KEY,
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
  `)

  migrateVectorColumns(db)
}

export function down(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS blocks_fts_insert;
    DROP TRIGGER IF EXISTS blocks_fts_update;
    DROP TRIGGER IF EXISTS blocks_fts_delete;
    DROP TABLE IF EXISTS autolink_suggestions;
    DROP TABLE IF EXISTS block_refs;
    DROP TABLE IF EXISTS vector_entries;
    DROP TABLE IF EXISTS vector_generations;
    DROP TABLE IF EXISTS vector_store_state;
    DROP TABLE IF EXISTS block_vectors;
    DROP TABLE IF EXISTS blocks_fts;
    DROP TABLE IF EXISTS blocks;
    DROP TABLE IF EXISTS assets;
    DROP TABLE IF EXISTS notebooks;
  `)
}

function migrateVectorColumns(database: Database): void {
  const columns = database.query('PRAGMA table_info(block_vectors)').all() as Array<{ name: string }>
  const names = new Set(columns.map((column) => column.name))
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
