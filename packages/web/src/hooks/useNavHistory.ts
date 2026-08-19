/**
 * 会话访问栈：Layout 负责记录路由变化；文档顶栏读快照并 navigate(-1/+1)。
 */

import { useRef, useSyncExternalStore } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  applyNavLocation,
  navHistorySnapshot,
  setCurrentNavLabel,
  subscribeNavHistory,
  type NavSnapshot,
} from '../lib/navHistory'

export function defaultNavLabel(pathname: string, t: (key: string) => string): string {
  if (pathname === '/') return t('sidebar.allDocs')
  if (pathname.startsWith('/inbox')) return t('sidebar.inbox')
  if (pathname.startsWith('/archived')) return t('sidebar.archived')
  if (pathname.startsWith('/trash')) return t('sidebar.trash')
  if (pathname.startsWith('/graph')) return t('sidebar.graph')
  if (pathname.startsWith('/resources')) return t('sidebar.resources')
  if (pathname.startsWith('/entities')) return t('sidebar.entities')
  if (pathname.startsWith('/settings')) return t('sidebar.settings')
  if (pathname.startsWith('/new')) return t('sidebar.newDoc')
  if (pathname.startsWith('/doc/')) return t('doc.untitledDocument')
  return pathname
}

/** 挂在 Layout：把 React Router 变化同步进访问栈（渲染期写入，顶栏首帧即可返回） */
export function useRecordNavHistory() {
  const location = useLocation()
  const kind = useNavigationType()
  const { t } = useTranslation()
  const seen = useRef('')
  const stamp = `${kind}:${location.pathname}${location.search}`
  if (seen.current !== stamp) {
    seen.current = stamp
    applyNavLocation(
      { pathname: location.pathname, search: location.search },
      kind,
      defaultNavLabel(location.pathname, t),
    )
  }
}

export function useNavHistory(): NavSnapshot & {
  goBack: () => void
  goForward: () => void
  setCurrentLabel: (label: string) => void
} {
  const navigate = useNavigate()
  const snap = useSyncExternalStore(subscribeNavHistory, navHistorySnapshot, navHistorySnapshot)
  return {
    ...snap,
    goBack: () => {
      if (navHistorySnapshot().canBack) navigate(-1)
    },
    goForward: () => {
      if (navHistorySnapshot().canForward) navigate(1)
    },
    setCurrentLabel: setCurrentNavLabel,
  }
}
