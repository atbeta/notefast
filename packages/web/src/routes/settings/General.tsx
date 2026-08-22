import { Sun, Moon, Monitor, Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../../hooks/useTheme'
import { useLocale } from '../../hooks/useLocale'
import { SUPPORTED_LOCALES } from '../../i18n/locales'
import { SettingsSection } from '../../components/settings/ui'

export default function SettingsGeneral() {
  const { t } = useTranslation()
  return (
    <SettingsSection id="general" title={t('settings.tabs.general')}>
      <ThemePicker />
      <LanguagePicker />
    </SettingsSection>
  )
}

function ThemePicker() {
  const { t } = useTranslation()
  const { theme, resolvedTheme, setTheme } = useTheme()
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-card p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[13.5px] font-medium text-foreground">{t('settings.theme.title')}</div>
          <p className="text-[12px] text-muted-foreground mt-1">
            {t('settings.theme.current')}：
            <span className="text-foreground">{resolvedTheme === 'dark' ? t('settings.theme.dark') : t('settings.theme.light')}</span>
            {theme === 'system' && (
              <span className="ml-1.5 text-muted-foreground/80">{t('settings.theme.systemSuffix')}</span>
            )}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <ThemeOption
          active={theme === 'light'}
          onClick={() => setTheme('light')}
          icon={<Sun className="w-4 h-4" strokeWidth={1.75} />}
          label={t('settings.theme.light')}
          hint={t('settings.theme.lightHint')}
        />
        <ThemeOption
          active={theme === 'dark'}
          onClick={() => setTheme('dark')}
          icon={<Moon className="w-4 h-4" strokeWidth={1.75} />}
          label={t('settings.theme.dark')}
          hint={t('settings.theme.darkHint')}
        />
        <ThemeOption
          active={theme === 'system'}
          onClick={() => setTheme('system')}
          icon={<Monitor className="w-4 h-4" strokeWidth={1.75} />}
          label={t('settings.theme.system')}
          hint={t('settings.theme.systemHint')}
        />
      </div>
    </div>
  )
}

function LanguagePicker() {
  const { t } = useTranslation()
  const { choice, locale, setLocale } = useLocale()
  const currentName = SUPPORTED_LOCALES.find((l) => l.code === locale)?.nativeName ?? locale
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-card p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[13.5px] font-medium text-foreground">{t('settings.language.title')}</div>
          <p className="text-[12px] text-muted-foreground mt-1">
            {t('settings.language.current')}：
            <span className="text-foreground">{currentName}</span>
            {choice === 'system' && (
              <span className="ml-1.5 text-muted-foreground/80">{t('settings.language.systemHint')}</span>
            )}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <ThemeOption
          active={choice === 'system'}
          onClick={() => setLocale('system')}
          icon={<Globe className="w-4 h-4" strokeWidth={1.75} />}
          label={t('settings.language.system')}
          hint={t('settings.language.systemHint')}
        />
        {SUPPORTED_LOCALES.map((l) => (
          <ThemeOption
            key={l.code}
            active={choice === l.code}
            onClick={() => setLocale(l.code)}
            icon={<Globe className="w-4 h-4" strokeWidth={1.75} />}
            label={l.nativeName}
            hint={l.code}
          />
        ))}
      </div>
    </div>
  )
}

function ThemeOption({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col items-start gap-1.5 px-3 py-2.5 rounded-lg border text-left transition-colors ${
        active
          ? 'border-foreground/30 bg-foreground/[0.04] text-foreground'
          : 'border-border/60 bg-background text-muted-foreground hover:text-foreground hover:border-foreground/20'
      }`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[12.5px] font-medium">{label}</span>
      </div>
      <span className="text-[10.5px] text-muted-foreground/80 leading-tight">{hint}</span>
    </button>
  )
}