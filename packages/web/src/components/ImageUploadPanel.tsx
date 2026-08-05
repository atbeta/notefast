import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageIcon } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useToast } from './ui'

interface ImageUploadConfig {
  version: 1
  mode: 'off' | 'auto'
  command: string
  args: string[]
  timeoutMs: number
}

/**
 * 图床上传设置（Typora 式命令契约）
 *
 * 图片始终先本地存储（内容寻址）；mode=auto 时异步 spawn 外部命令
 * （PicGo / upgit / picfast CLI / 任意脚本）传到图床，失败静默降级本地。
 * 命令契约：command [args...] <图片路径> → stdout 每行一个 http(s) URL。
 */
export default function ImageUploadPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [mode, setMode] = useState<'off' | 'auto'>('off')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [timeoutSec, setTimeoutSec] = useState(30)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api.get<ImageUploadConfig>('/assets/upload-config')
      .then((cfg) => {
        setMode(cfg.mode)
        setCommand(cfg.command)
        setArgsText(cfg.args.join(' '))
        setTimeoutSec(Math.round(cfg.timeoutMs / 1000))
      })
      .catch(() => { /* 配置不可读时保持默认 */ })
      .finally(() => setLoaded(true))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.put('/assets/upload-config', {
        mode,
        command,
        args: argsText.split(/\s+/).filter(Boolean),
        timeoutMs: timeoutSec * 1000,
      })
      toast.success({ title: t('settings.imageUpload.saved') })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error({ title: t('settings.imageUpload.saveFailed'), description: msg })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground/80 leading-relaxed">
        {t('settings.imageUpload.description')}
      </p>

      {/* 模式选择：不处理 / 自动上传 */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setMode('off')}
          className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
            mode === 'off'
              ? 'border-primary/50 bg-primary-softer/50'
              : 'border-border hover:border-foreground/30'
          }`}
        >
          <p className="text-[13px] font-medium text-foreground">{t('settings.imageUpload.modeOff')}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t('settings.imageUpload.modeOffHint')}</p>
        </button>
        <button
          type="button"
          onClick={() => setMode('auto')}
          className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
            mode === 'auto'
              ? 'border-primary/50 bg-primary-softer/50'
              : 'border-border hover:border-foreground/30'
          }`}
        >
          <p className="text-[13px] font-medium text-foreground">{t('settings.imageUpload.modeAuto')}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t('settings.imageUpload.modeAutoHint')}</p>
        </button>
      </div>

      {mode === 'auto' && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/25 p-3.5">
          <div>
            <label htmlFor="iu-command" className="text-[12px] font-medium text-muted-foreground block mb-1">
              {t('settings.imageUpload.command')}
            </label>
            <input
              id="iu-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="picgo upload / picfast upload / /path/to/script"
              className="input-mono w-full"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1">{t('settings.imageUpload.commandHint')}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="iu-args" className="text-[12px] font-medium text-muted-foreground block mb-1">
                {t('settings.imageUpload.args')}
              </label>
              <input
                id="iu-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-c /path/to/config"
                className="input-mono w-full"
                spellCheck={false}
              />
            </div>
            <div>
              <label htmlFor="iu-timeout" className="text-[12px] font-medium text-muted-foreground block mb-1">
                {t('settings.imageUpload.timeout')}
              </label>
              <input
                id="iu-timeout"
                type="number"
                min={1}
                max={300}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value) || 30)}
                className="input-mono w-full"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            {t('settings.imageUpload.contractHint')}
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <button type="button" onClick={() => void handleSave()} disabled={saving} className="btn-primary-custom">
          <ImageIcon className="w-3.5 h-3.5" strokeWidth={2} />
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
