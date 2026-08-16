/**
 * shared 包自包含的轻量 i18n 单例（与 NoteFast web 主 i18n 解耦）。
 *
 * - 只覆盖 shared 组件自身用到的 key：mermaid.* / math.* / chat.copy / copyBtn.*
 * - 单一 namespace：所有 t('key') 无需指定 ns
 * - 语言默认跟随浏览器（zh 前缀 → zh-CN，其余 → en）；宿主应用可在挂载前
 *   调用 setSharedLanguage() 强制指定（NoteFastEditor 设置页切换语言）。
 *
 * 注意：这是独立的 i18next 实例，不复用宿主应用的实例，避免 shared 的
 * key 污染宿主语言包、也避免宿主语言包缺失 shared key 时渲染英文 fallback。
 */

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './zh-CN.json'
import en from './en.json'

const prefersZh = (): boolean => {
  if (typeof navigator === 'undefined') return true
  return (navigator.language || 'zh').toLowerCase().startsWith('zh')
}

let initialized = false

function ensureInit(): void {
  if (initialized) return
  initialized = true
  i18next.use(initReactI18next).init({
    resources: {
      'zh-CN': zhCN,
      en,
    },
    lng: prefersZh() ? 'zh-CN' : 'en',
    fallbackLng: 'en',
    interpolation: {
      // React 默认做 JSX 转义；i18next 侧不再重复 escape
      escapeValue: false,
    },
    returnNull: false,
  })
}

// 模块加载即初始化（shared 组件 import 本模块即获得可用 t）
ensureInit()

/** 宿主应用切换语言（zh-CN | en）；下次渲染生效 */
export function setSharedLanguage(lang: 'zh-CN' | 'en'): void {
  ensureInit()
  i18next.changeLanguage(lang)
}

export default i18next
