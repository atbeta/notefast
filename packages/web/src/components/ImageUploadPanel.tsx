import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageIcon, X } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useToast } from './ui'

interface ImageUploadConfig {
  version: 1
  mode: 'off' | 'auto'
  command: string
  args: string[]
  timeoutMs: number
  last_error?: { at: string; message: string } | null
}

interface UploadTestResult {
  ok: boolean
  url?: string | null
  error?: string | null
  stdout?: string
  stderr?: string
  exit_code?: number | null
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
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<UploadTestResult | null>(null)
  const [lastError, setLastError] = useState<{ at: string; message: string } | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api.get<ImageUploadConfig>('/assets/upload-config')
      .then((cfg) => {
        setMode(cfg.mode)
        setCommand(cfg.command)
        setArgsText(cfg.args.join(' '))
        setTimeoutSec(Math.round(cfg.timeoutMs / 1000))
        setLastError(cfg.last_error ?? null)
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
      // 保存后刷新最近失败状态（语义：按最近上传尝试判定）
      void api.get<ImageUploadConfig>('/assets/upload-config')
        .then((cfg) => setLastError(cfg.last_error ?? null))
        .catch(() => {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error({ title: t('settings.imageUpload.saveFailed'), description: msg })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (mode !== 'auto' || !command.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.post<UploadTestResult>('/assets/upload-config/test', {})
      setTestResult(res)
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  /** 存量图片补传已迁至 资源页（资源 → 上传存量图片）——本面板只保留配置 + 测试 */

  if (!loaded) return null

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground/80 leading-relaxed">
        {t('settings.imageUpload.description')}
      </p>

      {/* 模式选择：不处理 / 自动上传（选中样式与 SyncPanel 双卡片选择器对齐） */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setMode('off')}
          className={`rounded-lg border px-3 py-2.5 text-left transition-all ${
            mode === 'off'
              ? 'border-primary/45 bg-primary-soft shadow-sm'
              : 'border-border bg-card hover:border-border-strong'
          }`}
        >
          <p className={`text-[13px] font-medium ${mode === 'off' ? 'text-primary' : 'text-foreground/80'}`}>{t('settings.imageUpload.modeOff')}</p>
          <p className="text-[11px] text-muted-foreground/80 mt-0.5">{t('settings.imageUpload.modeOffHint')}</p>
        </button>
        <button
          type="button"
          onClick={() => setMode('auto')}
          className={`rounded-lg border px-3 py-2.5 text-left transition-all ${
            mode === 'auto'
              ? 'border-primary/45 bg-primary-soft shadow-sm'
              : 'border-border bg-card hover:border-border-strong'
          }`}
        >
          <p className={`text-[13px] font-medium ${mode === 'auto' ? 'text-primary' : 'text-foreground/80'}`}>{t('settings.imageUpload.modeAuto')}</p>
          <p className="text-[11px] text-muted-foreground/80 mt-0.5">{t('settings.imageUpload.modeAutoHint')}</p>
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

          {lastError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-medium text-destructive mb-0.5">{t('settings.imageUpload.lastError')}</p>
                <button
                  type="button"
                  onClick={() => setLastError(null)}
                  className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                  aria-label={t('common.close')}
                >
                  <X className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
              </div>
              <p className="text-[11px] text-destructive/90 break-all leading-relaxed">{lastError.message}</p>
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">{new Date(lastError.at).toLocaleString()}</p>
            </div>
          )}

          {testResult && (
            <div className={`rounded-md border px-3 py-2 text-[11.5px] leading-relaxed ${
              testResult.ok ? 'border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-400' : 'border-destructive/30 bg-destructive/8 text-destructive/90'
            }`}>
              {testResult.ok && testResult.url ? (
                <p>{t('settings.imageUpload.testOk', { url: testResult.url })}</p>
              ) : (
                <>
                  <p className="font-medium">{t('settings.imageUpload.testFailed')}</p>
                  {testResult.error && <p className="break-all mt-0.5">{testResult.error}</p>}
                  {testResult.stderr && <pre className="whitespace-pre-wrap break-all mt-1 text-[10.5px] opacity-90 max-h-24 overflow-y-auto">{testResult.stderr}</pre>}
                  {testResult.stdout && <pre className="whitespace-pre-wrap break-all mt-1 text-[10.5px] opacity-80 max-h-24 overflow-y-auto">{testResult.stdout}</pre>}
                  {testResult.exit_code != null && <p className="mt-0.5 opacity-80">{t('settings.imageUpload.exitCode', { code: testResult.exit_code })}</p>}
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {mode === 'auto' && (
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing || !command.trim()}
            className="btn-ghost-custom"
          >
            {testing ? t('common.loading') : t('settings.imageUpload.test')}
          </button>
        )}
        <button type="button" onClick={() => void handleSave()} disabled={saving} className="btn-primary-custom">
          <ImageIcon className="w-3.5 h-3.5" strokeWidth={2} />
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}
