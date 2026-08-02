import { useStorageLocations } from '../hooks/useStorageLocations'
import { STORAGE_SECRET_MASK } from '@notefast/core'

/**
 * 存储连接下拉：备份 / 多端同步 / Markdown 归档共用。
 * value=locationId；options 过滤指定 kind；可选显示「新建连接…」入口（跳设置页）。
 */
export default function LocationSelect({
  value,
  onChange,
  kind,
  allowEmpty = true,
}: {
  value: string
  onChange: (id: string) => void
  kind?: 's3' | 'webdav'
  allowEmpty?: boolean
}) {
  const { locations } = useStorageLocations()
  const filtered = kind ? locations.filter((l) => l.kind === kind) : locations

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-1.5 rounded-md border border-border bg-background outline-none transition-all focus:ring-1 focus:ring-primary/30 focus:border-primary/50 text-[14px]"
    >
      {allowEmpty && <option value="">（选择存储连接）</option>}
      {filtered.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name} · {l.kind === 's3' ? 'S3' : 'WebDAV'}
          {l.kind === 's3' && l.s3?.accessKeyId === STORAGE_SECRET_MASK ? ' ✓' : ''}
        </option>
      ))}
      {filtered.length === 0 && (
        <option value="" disabled>
          暂无连接，请先在「存储连接」面板创建
        </option>
      )}
    </select>
  )
}
