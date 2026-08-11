import { useEffect, useState, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { DocFontSizeApplier } from './hooks/useDocFontSize'
import HomePage from './routes/home'
import DocPage from './routes/doc'
import NewDocPage from './routes/new'
import InboxPage from './routes/inbox'
import ArchivedPage from './routes/archived'
import TrashPage from './routes/trash'
// 二级路由（entities/graph/resources/settings/share）：用户不常跳，提起代码分割。
// 主页（home/doc/new/inbox/archived/trash）是主路径，不 lazy——首屏体验优先。
const EntitiesPage = lazy(() => import('./routes/entities'))
const GraphPage = lazy(() => import('./routes/graph'))
const ResourcesPage = lazy(() => import('./routes/resources'))
const SettingsLayout = lazy(() => import('./routes/settings'))
const SettingsGeneral = lazy(() => import('./routes/settings/General'))
const SettingsAI = lazy(() => import('./routes/settings/AI'))
const SettingsTermDict = lazy(() => import('./routes/settings/TermDict'))
const SettingsImages = lazy(() => import('./routes/settings/Images'))
const SettingsBackup = lazy(() => import('./routes/settings/Backup'))
const SettingsTokens = lazy(() => import('./routes/settings/Tokens'))
const SettingsSecurity = lazy(() => import('./routes/settings/Security'))
const SharePage = lazy(() => import('./routes/share'))
import Layout from './components/Layout'
import RouteTransition from './components/RouteTransition'
import RouteBoundary from './components/RouteBoundary'
import RouteLoadingShell from './components/RouteLoadingShell'
import AuthPrompt from './components/AuthPrompt'
import { ToastProvider } from './components/ui'
import { getStoredToken } from './hooks/useAPI'

interface AuthMode {
  passwordRequired: boolean
  tokenRequired: boolean
}

export default function App() {
  const contentClassName = 'w-full h-full'
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)
  const location = useLocation()
  // 公开分享页：无侧栏、无登录弹框、不探测鉴权模式
  const isPublicShare = location.pathname.startsWith('/s/')

  // 启动探测：服务端是否需要密码
  useEffect(() => {
    if (isPublicShare) return
    fetch('/api/v1/auth/mode')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((mode: AuthMode) => setAuthMode(mode))
      .catch(() => setAuthMode({ passwordRequired: false, tokenRequired: false }))
  }, [isPublicShare])

  if (isPublicShare) {
    return (
      <Routes>
        <Route
          path="/s/:token"
          element={
            <RouteBoundary name="share">
              <Suspense fallback={<RouteLoadingShell />}>
                <SharePage />
              </Suspense>
            </RouteBoundary>
          }
        />
      </Routes>
    )
  }

  // 探测未完成 → 不渲染内容（避免短暂闪现未鉴权页面）
  // 探测完成 + 需要密码 + 本地没有可用密码（持久化/会话级均无）→ 仅登录页，不挂 Layout（避免「已进入被遮挡」）
  const showAuthPrompt = authMode?.passwordRequired === true && !getStoredToken()

  if (showAuthPrompt) {
    return (
      <ToastProvider>
        <AuthPrompt />
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <DocFontSizeApplier />
      <Layout contentClassName={contentClassName}>
        <RouteTransition>
          <Routes>
            <Route path="/" element={<RouteBoundary name="home"><HomePage /></RouteBoundary>} />
            <Route path="/new" element={<RouteBoundary name="new"><NewDocPage /></RouteBoundary>} />
            <Route path="/doc/:id" element={<RouteBoundary name="doc"><DocPage /></RouteBoundary>} />
            <Route path="/inbox" element={<RouteBoundary name="inbox"><InboxPage /></RouteBoundary>} />
            <Route path="/archived" element={<RouteBoundary name="archived"><ArchivedPage /></RouteBoundary>} />
            <Route path="/trash" element={<RouteBoundary name="trash"><TrashPage /></RouteBoundary>} />
            <Route
              path="/resources"
              element={
                <RouteBoundary name="resources">
                  <Suspense fallback={<RouteLoadingShell />}>
                    <ResourcesPage />
                  </Suspense>
                </RouteBoundary>
              }
            />
            <Route
              path="/entities"
              element={
                <RouteBoundary name="entities">
                  <Suspense fallback={<RouteLoadingShell />}>
                    <EntitiesPage />
                  </Suspense>
                </RouteBoundary>
              }
            />
            <Route
              path="/graph"
              element={
                <RouteBoundary name="graph">
                  <Suspense fallback={<RouteLoadingShell />}>
                    <GraphPage />
                  </Suspense>
                </RouteBoundary>
              }
            />
            <Route
              path="/settings"
              element={
                <RouteBoundary name="settings">
                  <Suspense fallback={<RouteLoadingShell />}>
                    <SettingsLayout />
                  </Suspense>
                </RouteBoundary>
              }
            >
              <Route index element={<Navigate to="general" replace />} />
              <Route
                path="general"
                element={
                  <Suspense fallback={<RouteLoadingShell />}>
                    <SettingsGeneral />
                  </Suspense>
                }
              />
              <Route
                path="ai"
                element={
                  <Suspense fallback={<RouteLoadingShell />}>
                    <SettingsAI />
                  </Suspense>
                }
              />
              <Route
                path="termdict"
                element={
                  <Suspense fallback={<RouteLoadingShell />}>
                    <SettingsTermDict />
                  </Suspense>
                }
              />
              <Route
                path="images"
                element={
                  <Suspense fallback={<RouteLoadingShell />}>
                    <SettingsImages />
                  </Suspense>
                }
              />
              <Route
                path="backup"
                element={
                  <Suspense fallback={<RouteLoadingShell />}>
                    <SettingsBackup />
                  </Suspense>
                }
              />
              <Route
                path="tokens"
                element={
                  <Suspense fallback={<RouteLoadingShell />}>
                    <SettingsTokens />
                  </Suspense>
                }
              />
              <Route
                path="security"
                element={
                  <Suspense fallback={<RouteLoadingShell />}>
                    <SettingsSecurity />
                  </Suspense>
                }
              />
              {/* 兜底：未识别子路径跳到 general */}
              <Route path="*" element={<Navigate to="general" replace />} />
            </Route>
          </Routes>
        </RouteTransition>
      </Layout>
    </ToastProvider>
  )
}