import type { Database } from 'bun:sqlite'

export const id = '010_tag_cleanup'
export const description = 'Backfill tags column from properties JSON, then strip tags from properties'

export function up(db: Database): void {
  const rows = db.query(
    "SELECT id, properties, tags FROM blocks WHERE properties IS NOT NULL AND properties != '{}'",
  ).all() as Array<{ id: string; properties: string; tags: string }>

  const updateProp = db.query('UPDATE blocks SET tags = ?, properties = ? WHERE id = ?')

  for (const row of rows) {
    let props: Record<string, unknown> = {}
    try { props = JSON.parse(row.properties) } catch { continue }

    const propTags = Array.isArray(props.tags)
      ? (props.tags as string[]).filter((t): t is string => typeof t === 'string')
      : []

    let colTags: string[] = []
    try { const p = JSON.parse(row.tags ?? '[]'); if (Array.isArray(p)) colTags = p.filter((t): t is string => typeof t === 'string') } catch {}

    if (propTags.length === 0) continue

    const merged = [...new Set([...colTags, ...propTags.map((t) => t.toLowerCase().replace(/\s+/g, '-').slice(0, 64))])]
    const nextProps = { ...props }
    delete nextProps.tags

    updateProp.run(JSON.stringify(merged), JSON.stringify(nextProps), row.id)
  }
}
