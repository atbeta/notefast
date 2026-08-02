import { useState } from 'react'
import { Plus, Pencil, Trash2, Cloud } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, useToast } from './ui'
import { SettingsCard, InlineField } from './settings/ui'
import { useStorageLocations } from '../hooks/useStorageLocations'
import { STORAGE_SECRET_MASK, type StorageLocation } from '@notefast/core'

/**
 * 存储连接管理面板：备份 / 多端同步 / Markdown 归档 共用的连接（bucket/凭据）只填一次。
 * 支持 S3（含 R2/MinIO）与 WebDAV。
 */
export default function StorageLocationsPanel() {
  const { locations, refresh } = useStorageLocations()
  const toast = useToast()
  const [editing, setEditing] = useState<StorageLocation | 'new' | null>(null)
  const [kind, setKind] = useState<'s3' | 'webdav'>('s3')
  const [name, setName] = useState('')
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('auto')
  const [endpoint, setEndpoint] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [forcePathStyle, setForcePathStyle] = useState(false)
  const [davEndpoint, setDavEndpoint] = useState('')
  const [davUsername, setDavUsername] = useState('')
  const [davPassword, setDavPassword] = useState('')

  const startNew = () => {
    setEditing('new')
    setKind('s3')
    setName('')
    setBucket('')
    setRegion('auto')
    setEndpoint('')
    setAccessKeyId('')
    setSecretAccessKey('')
    setForcePathStyle(false)
    setDavEndpoint('')
    setDavUsername('')
    setDavPassword('')
  }

  const startEdit = (loc: StorageLocation) => {
    setEditing(loc)
    setKind(loc.kind)
    setName(loc.name)
    setBucket(loc.s3?.bucket ?? '')
    setRegion(loc.s3?.region ?? 'auto')
    setEndpoint(loc.s3?.endpoint ?? '')
    setAccessKeyId(loc.s3?.accessKeyId === STORAGE_SECRET_MASK ? '' : loc.s3?.accessKeyId ?? '')
    setSecretAccessKey(loc.s3?.secretAccessKey === STORAGE_SECRET_MASK ? '' : loc.s3?.secretAccessKey ?? '')
    setForcePathStyle(Boolean(loc.s3?.forcePathStyle))
    setDavEndpoint(loc.webdav?.endpoint ?? '')
    setDavUsername(loc.webdav?.username === STORAGE_SECRET_MASK ? '' : loc.webdav?.username ?? '')
    setDavPassword(loc.webdav?.password === STORAGE_SECRET_MASK ? '' : loc.webdav?.password ?? '')
  }

  const handleSave = async () => {
    await toast.promise(
      async () => {
        const body = {
          name,
          kind,
          ...(kind === 's3'
            ? { s3: { bucket, region, endpoint: endpoint || undefined, accessKeyId: accessKeyId || undefined, secretAccessKey: secretAccessKey || undefined, forcePathStyle } }
            : { webdav: { endpoint: davEndpoint, username: davUsername || undefined, password: davPassword || undefined } }),
        }
        if (editing === 'new') {
          await api.post('/storage-locations', body)
        } else if (editing) {
          await api.put(`/storage-locations/${editing.id}`, body)
        }
        await refresh()
        setEditing(null)
      },
      {
        loading: '正在保存存储连接…',
        success: '存储连接已保存',
        error: (e) => ({ title: '保存失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  const handleDelete = async (loc: StorageLocation) => {
    await toast.promise(
      async () => {
        await api.del(`/storage-locations/${loc.id}`)
        await refresh()
      },
      {
        loading: '正在删除连接…',
        success: '连接已删除（引用它的能力将显示未配置）',
        error: (e) => ({ title: '删除失败', description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  return (
    <SettingsCard
      title="存储连接"
      icon={<Cloud className="w-4 h-4" strokeWidth={1.75} />}
      helpTip="备份、多端同步与 Markdown 归档共用这里的连接（S3 / WebDAV）。bucket、区域与凭据只需在此填一次，各能力只选择连接 + 自己的前缀（目录）即可。"
      defaultExpanded={locations.length === 0}
    >
      <div className="space-y-4">
        {locations.length === 0 && (
          <p className="text-[12.5px] text-muted-foreground">
            还没有存储连接。创建第一个后，即可在备份 / 多端同步 / Markdown 归档中选用。
          </p>
        )}

        {locations.map((loc) => (
          <div key={loc.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg border border-border/60 bg-accent/10">
            <div className="min-w-0">
              <div className="font-medium text-foreground text-[13px] truncate">{loc.name}</div>
              <div className="text-muted-foreground text-[11.5px] mt-0.5 font-mono truncate">
                {loc.kind === 's3'
                  ? `S3 · s3://${loc.s3?.bucket ?? ''}${loc.s3?.endpoint ? ` · ${loc.s3.endpoint}` : ''}`
                  : `WebDAV · ${loc.webdav?.endpoint ?? ''}`}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button type="button" onClick={() => startEdit(loc)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" title="编辑">
                <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
              <button type="button" onClick={() => handleDelete(loc)} className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title="删除">
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
            </div>
          </div>
        ))}

        {editing ? (
          <div className="space-y-4 pt-2 border-t border-border/40">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setKind('s3')}
                className={`px-3 py-1.5 rounded-md text-[12.5px] font-medium transition-colors ${kind === 's3' ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground'}`}
              >
                S3 / R2 / MinIO
              </button>
              <button
                type="button"
                onClick={() => setKind('webdav')}
                className={`px-3 py-1.5 rounded-md text-[12.5px] font-medium transition-colors ${kind === 'webdav' ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground'}`}
              >
                WebDAV
              </button>
            </div>
            <InlineField label="名称" value={name} onChange={setName} placeholder="如：我的 R2 / 群晖 NAS" />
            {kind === 's3' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                <InlineField label="Bucket" value={bucket} onChange={setBucket} mono placeholder="my-notefast-bucket" />
                <InlineField label="Region" value={region} onChange={setRegion} mono placeholder="auto" />
                <InlineField label="Endpoint" description="R2 / MinIO 必填" value={endpoint} onChange={setEndpoint} mono placeholder="https://xxx.r2.cloudflarestorage.com" />
                <InlineField label="Access Key ID" value={accessKeyId} onChange={setAccessKeyId} mono placeholder={STORAGE_SECRET_MASK} />
                <InlineField label="Secret Access Key" value={secretAccessKey} onChange={setSecretAccessKey} mono type="password" placeholder={STORAGE_SECRET_MASK} />
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={forcePathStyle} onChange={(e) => setForcePathStyle(e.target.checked)} className="rounded border-border" />
                  <span className="text-[13px] text-foreground">Path-style endpoint</span>
                  <span className="text-[11px] text-muted-foreground/60">MinIO 必需，AWS / R2 默认关闭</span>
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                <InlineField label="WebDAV 端点" value={davEndpoint} onChange={setDavEndpoint} mono placeholder="https://dav.example.com/remote.php/webdav" />
                <InlineField label="用户名" value={davUsername} onChange={setDavUsername} mono placeholder={STORAGE_SECRET_MASK} />
                <InlineField label="密码" value={davPassword} onChange={setDavPassword} mono type="password" placeholder={STORAGE_SECRET_MASK} />
              </div>
            )}
            <div className="flex items-center gap-3 pt-2">
              <ActionButton onAction={handleSave}>保存连接</ActionButton>
              <ActionButton variant="secondary" onAction={() => setEditing(null)}>取消</ActionButton>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={startNew}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border text-[12.5px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
            新增存储连接
          </button>
        )}
      </div>
    </SettingsCard>
  )
}
