import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getLoadablePath } from 'sqlite-vec'

let configured = false

function vecSuffix(): string {
  if (process.platform === 'darwin') return 'dylib'
  if (process.platform === 'win32') return 'dll'
  return 'so'
}

export function configureSqliteForExtensions(): void {
  if (configured || process.platform !== 'darwin') return

  const candidates = [
    process.env.SQLITE_LIBRARY_PATH,
    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
    '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
  ].filter((path): path is string => Boolean(path))
  const library = candidates.find((path) => existsSync(path))
  if (!library) {
    throw new Error(
      'macOS 上 sqlite-vec 需要支持扩展加载的 SQLite；请执行 brew install sqlite，'
      + '或通过 SQLITE_LIBRARY_PATH 指定 libsqlite3.dylib',
    )
  }
  Database.setCustomSQLite(library)
  configured = true
}

export function resolveSqliteVecPath(): string {
  const explicit = process.env.SQLITE_VEC_PATH?.trim()
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`SQLITE_VEC_PATH 不存在: ${explicit}`)
    }
    return explicit
  }

  const fileName = `vec0.${vecSuffix()}`
  const candidates = [
    join(import.meta.dir, 'native', fileName),
    // 兼容 bun build 产物旁的 native/，以及 Docker runner 的 server-dist/native
    process.argv[1] ? join(dirname(process.argv[1]), 'native', fileName) : '',
    join(process.cwd(), 'native', fileName),
    join(process.cwd(), 'server-dist', 'native', fileName),
    join(process.cwd(), 'packages', 'server', 'dist', 'native', fileName),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  try {
    return getLoadablePath()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `找不到 sqlite-vec 动态库（已尝试: ${candidates.join(', ')}）。`
      + `请先 bun run build，或设置 SQLITE_VEC_PATH。原始错误: ${detail}`,
    )
  }
}

export function loadSqliteVec(db: Database): string {
  const path = resolveSqliteVecPath()
  db.loadExtension(path)
  const row = db.query('SELECT vec_version() AS version').get() as { version: string } | null
  if (!row?.version) throw new Error('sqlite-vec 已加载但 vec_version() 不可用')
  return row.version
}
