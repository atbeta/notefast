/**
 * i18next 单例初始化。
 *
 * - 单一 translation namespace：所有 t('key') 无需指定 ns
 * - 语言包按域拆分为独立 JSON（zh-CN/*.json），index.ts 深合并注册
 * - 初始语言 = localStorage 选择（system → 浏览器语言），由 useLocale store 驱动后续切换
 * - 非组件代码（lib/time.ts、hooks/useAPI.ts 等）直接 import 本单例调 i18next.t()
 */

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './zh-CN'
import { DEFAULT_LOCALE, readStoredLocaleChoice, resolveLocale } from './locales'

const initialLng = resolveLocale(readStoredLocaleChoice())

i18next.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
  },
  lng: initialLng,
  fallbackLng: DEFAULT_LOCALE,
  interpolation: {
    // React 默认做 JSX 转义；i18next 侧不再重复 escape
    escapeValue: false,
  },
  returnNull: false,
})

export default i18next
