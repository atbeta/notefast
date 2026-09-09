/**
 * vault 索引目录解析（RFC 0001 D4 / RFC 0005 D3）
 *
 * 一个 vault 一个索引目录：`<父目录>/<sha256(canonical vault path) 前 12 位>`。
 * 这段逻辑必须由**引擎**统一持有——桌面壳（`native/bootstrap.ts`）、Docker / `bun dev`
 * （`index.ts`）都走这里，否则同一份代码在不同部署方式下索引位置会分叉（RFC 0005 D1）。
 *
 * 本模块只依赖 node 内置模块与 bun:sqlite，不引入 vault 运行时，避免循环依赖。
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { configureSqliteForExtensions } from '../sqliteVec'

/** SQLite 索引文件名（`db.ts` 的约定，别写成 index.sqlite） */
export const DB_FILE_NAME = 'notefast.db'

/** 每 vault 索引目录名 = sha256 前 N 位十六进制（RFC 0001 D4） */
export const VAULT_DIR_HASH_LEN = 12

/**
 * vault 路径规范化：绝对化 → 解析符号链接（路径已存在时）→ 去尾部分隔符。
 * 用途是让「同一个文件夹的不同写法」落到同一个索引目录：macOS 上
 * `~/Documents` 与 `/Users/x/Documents`、`/tmp/x` 与 `/private/tmp/x` 必须同 hash。
 */
export function canonicalVaultPath(vaultPath: string): string {
  const abs = resolve(vaultPath)
  let canonical = abs
  try {
    // realpathSync.native 同时给出磁盘上的真实大小写（Windows / 大小写不敏感卷）
    canonical = realpathSync.native(abs)
  } catch {
    // 路径暂不存在（用户选了个还没建的目录）：退化为 resolve 结果
  }
  const stripped = canonical.replace(/[\\/]+$/, '')
  return stripped || canonical
}

/** vault 路径 → 索引目录名（sha256 前 12 位十六进制） */
export function vaultPathHash(vaultPath: string): string {
  return createHash('sha256')
    .update(canonicalVaultPath(vaultPath))
    .digest('hex')
    .slice(0, VAULT_DIR_HASH_LEN)
}

/**
 * 一个 vault 一个 DATA_DIR：`<appSupportDir>/<sha256(canonical vault path) 前 12 位>`。
 * 索引留在应用支持目录（不进 vault，避免 git / iCloud 同步 SQLite 损坏），
 * 且不同 vault 互不覆盖（RFC 0001 D4）。
 */
export function vaultDataDir(vaultPath: string, appSupportDir: string): string {
  return join(appSupportDir, vaultPathHash(vaultPath))
}

/** 应用支持目录缺省值（未显式传 `--app-support-dir` / `NOTEFAST_APP_SUPPORT_DIR` 时用） */
export function defaultAppSupportDir(): string {
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'NoteFast')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    return join(appData, 'com.notefast.desktop')
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
  return join(xdg, 'notefast')
}

/** 索引父目录下的既有索引归属（用于兼容 0.90.0 及更早的 Docker 布局） */
export interface LegacyIndexInfo {
  kind: 'vault' | 'db' | 'unknown'
  vaultRoot: string | null
}

/**
 * 看一眼 `<dir>/notefast.db` 是谁的库。
 * 读不到（文件不存在 / 表结构更旧 / 不是 sqlite）一律回 `null` / `unknown`，不抛异常。
 */
export function inspectIndexAt(dir: string): LegacyIndexInfo | null {
  const file = join(dir, DB_FILE_NAME)
  if (!existsSync(file)) return null
  // WAL 模式下 readonly 打开会因无法创建 -shm 而失败（bun:sqlite 报 unable to open database file），
  // 所以先试只读，失败再退回读写；只发一条 SELECT，不会改数据。
  for (const readonly of [true, false]) {
    let db: Database | null = null
    try {
      db = new Database(file, { readonly })
      const row = db.query('SELECT kind, vault_root FROM notebooks LIMIT 1').get() as
        | { kind?: string | null; vault_root?: string | null }
        | null
      if (!row) return { kind: 'unknown', vaultRoot: null }
      const kind = row.kind === 'vault' ? 'vault' : row.kind === 'db' ? 'db' : 'unknown'
      return { kind, vaultRoot: row.vault_root ?? null }
    } catch {
      /* 换另一种打开方式再试 */
    } finally {
      try {
        db?.close()
      } catch {
        /* 只读探测，关不掉也无所谓 */
      }
    }
  }
  return { kind: 'unknown', vaultRoot: null }
}

/**
 * vault 模式的索引目录（RFC 0005 D3）：一律派生 `<parent>/<sha256 前 12 位>`。
 *
 * 兼容 0.90.0 及更早的 Docker 布局（索引直接落在父目录）：只有当旧索引本来就是
 * **同一个 vault** 时才沿用并告警；旧索引是 db notebook 或别的 vault 时直接报错，
 * 避免静默启用一个空的第二个知识库。
 */
export function resolveVaultDataDir(
  vaultPath: string,
  parentDir: string,
): { dataDir: string; legacyReused: boolean } {
  const derived = vaultDataDir(vaultPath, parentDir)
  if (existsSync(join(derived, DB_FILE_NAME))) return { dataDir: derived, legacyReused: false }
  const legacy = inspectIndexAt(parentDir)
  if (!legacy) return { dataDir: derived, legacyReused: false }
  const sameVault =
    legacy.kind === 'vault' &&
    legacy.vaultRoot !== null &&
    canonicalVaultPath(legacy.vaultRoot) === canonicalVaultPath(vaultPath)
  if (sameVault) {
    console.warn(
      `[notefast] 沿用旧版索引位置 ${parentDir}（未派生到 ${derived}）；` +
        '这是 0.90.0 及更早的 Docker 布局，可继续使用',
    )
    return { dataDir: parentDir, legacyReused: true }
  }
  const who = legacy.kind === 'db' ? 'db notebook' : '其他 vault'
  throw new Error(
    `索引目录 ${parentDir} 下已有 ${DB_FILE_NAME}（${who}），而 vault 模式的索引应派生到 ${derived}。\n` +
      '请二选一：① 把旧索引移走（或换一个索引父目录）后再启动；' +
      '② 若想继续用旧库，请以 db 模式启动（不设 VAULT_PATH）。',
  )
}

/**
 * 从环境变量解析 vault 索引的父目录：显式应用支持目录 > DATA_DIR（Docker 的写法）> 平台缺省。
 * 两条入口（壳 / Docker）共用，避免规则分叉。
 */
export function resolveIndexParentDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.NOTEFAST_APP_SUPPORT_DIR?.trim() ||
    env.DATA_DIR?.trim() ||
    defaultAppSupportDir()
  )
}

/**
 * 解析 vault 索引目录，必要时先配置 SQLite 扩展加载。
 *
 * 为什么要先配置：`inspectIndexAt` 会 `new Database(...)`，而 bun:sqlite 在第一次打开数据库时
 * 就自动加载系统 SQLite，之后 `Database.setCustomSQLite()` 会报「SQLite already loaded」
 * （macOS 上 sqlite-vec 必须换用带扩展加载的 libsqlite3）。所以只有真的要探测旧索引时才配置，
 * 且必须在打开任何数据库之前。
 */
export function resolveVaultDataDirWithProbe(
  vaultPath: string,
  parentDir: string,
): { dataDir: string; legacyReused: boolean } {
  if (existsSync(join(parentDir, DB_FILE_NAME))) configureSqliteForExtensions()
  return resolveVaultDataDir(vaultPath, parentDir)
}
