import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Sliders,
  Sparkles,
  BookOpen,
  Image,
  HardDriveDownload,
  Plug,
  ShieldCheck,
} from 'lucide-react'

const NAV_ITEMS = [
  { to: 'general', tabKey: 'general', Icon: Sliders },
  { to: 'ai', tabKey: 'ai', Icon: Sparkles },
  { to: 'termdict', tabKey: 'termdict', Icon: BookOpen },
  { to: 'images', tabKey: 'images', Icon: Image },
  { to: 'backup', tabKey: 'backup', Icon: HardDriveDownload },
  { to: 'tokens', tabKey: 'tokens', Icon: Plug },
  { to: 'security', tabKey: 'security', Icon: ShieldCheck },
] as const

export default function SettingsLayout() {
  const { t } = useTranslation()

  return (
    <div className="w-full max-w-5xl mx-auto px-4 sm:px-8 py-8 sm:py-10 animate-fade-in pb-32">
      <header className="space-y-3 mb-6 sm:mb-8">
        <h1 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">
          {t('settings.title')}
        </h1>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          {t('settings.description')}
        </p>
      </header>

      <div className="lg:grid lg:grid-cols-[200px_1fr] lg:gap-10">
        {/* 桌面端：左侧二级导航（sticky） */}
        <aside className="hidden lg:block">
          <nav className="sticky top-4 space-y-0.5">
            {NAV_ITEMS.map(({ to, tabKey, Icon }) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] transition-colors ${
                    isActive
                      ? 'bg-foreground/[0.06] text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }`
                }
              >
                <Icon className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{t(`settings.tabs.${tabKey}`)}</span>
              </NavLink>
            ))}
          </nav>
        </aside>

        {/* 移动端：顶部胶囊 tabs（窄屏下保留横向滚动） */}
        <div className="lg:hidden mb-5 sticky top-0 z-20 -mx-2 px-2 py-3 bg-background/80 backdrop-blur-md border-b border-border/50">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar mask-edges">
            {NAV_ITEMS.map(({ to, tabKey, Icon: _ }) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) =>
                  `whitespace-nowrap px-3 py-1.5 text-[13px] font-medium rounded-full transition-colors ${
                    isActive
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                  }`
                }
              >
                {t(`settings.tabs.${tabKey}`)}
              </NavLink>
            ))}
          </div>
        </div>

        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}