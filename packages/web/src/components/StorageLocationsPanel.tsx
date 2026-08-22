import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2, Cloud } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { ActionButton, EmptyState, Tooltip, useToast } from './ui'
import { SettingsCard, InlineField } from './settings/ui'
import { useStorageLocations } from '../hooks/useStorageLocations'
import { STORAGE_SECRET_MASK, type StorageLocation } from '@notefast/core'

/**
 * 存储连接管理面板：备份 / 多端同步 / Markdown 归档 共用的连接（bucket/凭据）只填一次。
 * 支持 S3 兼容（AWS / R2 / MinIO 等）与 WebDAV。
 */
export default function StorageLocationsPanel() {
  const { t } = useTranslation()
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
        loading: t('storageLoc.saving'),
        success: t('storageLoc.saved'),
        error: (e) => ({ title: t('storageLoc.saveFailed'), description: e instanceof Error ? e.message : String(e) }),
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
        loading: t('storageLoc.deleting'),
        success: t('storageLoc.deleted'),
        error: (e) => ({ title: t('storageLoc.deleteFailed'), description: e instanceof Error ? e.message : String(e) }),
      },
    ).catch(() => undefined)
  }

  return (
    <SettingsCard
      title={t('storageLoc.title')}
      icon={<Cloud className="w-4 h-4" strokeWidth={1.75} />}
      helpTip={t('storageLoc.helpTip')}
    >
      <div className="space-y-4">
        {locations.length === 0 && (
          <EmptyState
            className="py-6"
            icon={<Cloud className="w-5 h-5" />}
            title={t('storageLoc.empty')}
          />
        )}

        {locations.map((loc) => (
          <div key={loc.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg border border-border/60 bg-accent/10">
            <div className="min-w-0">
              <div className="font-medium text-foreground text-base truncate">{loc.name}</div>
              <div className="text-muted-foreground text-xs mt-0.5 font-mono truncate">
                {loc.kind === 's3'
                  ? `S3 · s3://${loc.s3?.bucket ?? ''}${loc.s3?.endpoint ? ` · ${loc.s3.endpoint}` : ''}`
                  : `WebDAV · ${loc.webdav?.endpoint ?? ''}`}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Tooltip label={t('storageLoc.edit')}>
                <button type="button" onClick={() => startEdit(loc)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" aria-label={t('storageLoc.edit')}>
                  <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
                </button>
              </Tooltip>
              <Tooltip label={t('storageLoc.delete')}>
                <button type="button" onClick={() => handleDelete(loc)} className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" aria-label={t('storageLoc.delete')}>
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                </button>
              </Tooltip>
            </div>
          </div>
        ))}

        {editing ? (
          <div className="space-y-4 pt-2 border-t border-border/40">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setKind('s3')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${kind === 's3' ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground'}`}
              >
                S3 兼容
              </button>
              <button
                type="button"
                onClick={() => setKind('webdav')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${kind === 'webdav' ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground'}`}
              >
                WebDAV
              </button>
            </div>
            <InlineField label={t('storageLoc.name')} value={name} onChange={setName} placeholder={t('storageLoc.namePlaceholder')} />
            {kind === 's3' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                <InlineField label="Bucket" value={bucket} onChange={setBucket} mono placeholder="my-notefast-bucket" />
                <InlineField label="Region" value={region} onChange={setRegion} mono placeholder="auto" />
                <InlineField label={t('storageLoc.endpoint')} description={t('storageLoc.endpointRequired')} value={endpoint} onChange={setEndpoint} mono placeholder="https://xxx.r2.cloudflarestorage.com" />
                <InlineField label="Access Key ID" value={accessKeyId} onChange={setAccessKeyId} mono placeholder={STORAGE_SECRET_MASK} />
                <InlineField label="Secret Access Key" value={secretAccessKey} onChange={setSecretAccessKey} mono type="password" placeholder={STORAGE_SECRET_MASK} />
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={forcePathStyle} onChange={(e) => setForcePathStyle(e.target.checked)} className="rounded-md border-border" />
                  <span className="text-base text-foreground">{t('storageLoc.pathStyle')}</span>
                  <span className="text-xs text-muted-foreground/60">{t('storageLoc.pathStyleHint')}</span>
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                <InlineField label={t('storageLoc.davEndpoint')} value={davEndpoint} onChange={setDavEndpoint} mono placeholder="https://dav.example.com/remote.php/webdav" />
                <InlineField label={t('storageLoc.username')} value={davUsername} onChange={setDavUsername} mono placeholder={STORAGE_SECRET_MASK} />
                <InlineField label={t('storageLoc.password')} value={davPassword} onChange={setDavPassword} mono type="password" placeholder={STORAGE_SECRET_MASK} />
              </div>
            )}
            <div className="flex items-center gap-3 pt-2">
              <ActionButton onAction={handleSave}>{t('storageLoc.save')}</ActionButton>
              <ActionButton variant="secondary" onAction={() => setEditing(null)}>{t('common.cancel')}</ActionButton>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={startNew}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
            {t('storageLoc.addNew')}
          </button>
        )}
      </div>
    </SettingsCard>
  )
}
