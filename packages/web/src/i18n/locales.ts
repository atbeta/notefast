/**
 * 语言注册表：可用语言 + 匹配逻辑。
 *
 * 未来开放新语言的唯一动作：
 * 1. 新增语言包文件并挂到 zh-CN/ 同级（如 en.json → en/index.ts）
 * 2. 在 SUPPORTED_LOCALES 追加一项
 * 3. 同步 index.html 内联防闪烁脚本里的 SUPPORTED_CODES 列表
 */

export interface LocaleInfo {
  /** BCP 47 代码，同时是 i18next lng 与 <html lang> 值 */
  code: string
  /** 语言自身名称（用于语言选择 UI，不做翻译） */
  nativeName: string
}

/** 已内置语言包的注册表；顺序即设置页展示顺序 */
export const SUPPORTED_LOCALES: LocaleInfo[] = [
  { code: 'zh-CN', nativeName: '简体中文' },
  { code: 'en', nativeName: 'English' },
]

/** 兜底语言：无法匹配任何受支持语言时的回退 */
export const DEFAULT_LOCALE = 'zh-CN'

export const LOCALE_STORAGE_KEY = 'notefast.locale'

/** 'system'（或缺省）表示跟随浏览器语言；任意 code 若不受支持则回退 */
export function resolveLocale(choice: string | null | undefined, systemLocale?: string): string {
  if (choice && choice !== 'system') {
    const exact = SUPPORTED_LOCALES.find((l) => l.code.toLowerCase() === choice.toLowerCase())
    if (exact) return exact.code
  }
  const sys = (systemLocale || (typeof navigator !== 'undefined' ? (navigator.language ?? '') : '')).toLowerCase()
  const exact = SUPPORTED_LOCALES.find((l) => l.code.toLowerCase() === sys)
  if (exact) return exact.code
  const primary = sys.split('-')[0]
  const byPrimary = SUPPORTED_LOCALES.find((l) => l.code.toLowerCase().startsWith(primary))
  return byPrimary ? byPrimary.code : DEFAULT_LOCALE
}

/** 读取 localStorage 里的语言选择；异常/非法值一律当 'system' */
export function readStoredLocaleChoice(): string | null {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (v === 'system') return 'system'
    if (v && SUPPORTED_LOCALES.some((l) => l.code.toLowerCase() === v.toLowerCase())) return v
    return null
  } catch {
    return null
  }
}
