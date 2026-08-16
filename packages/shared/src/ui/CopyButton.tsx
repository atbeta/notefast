import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check } from 'lucide-react'
import { Tooltip } from './Tooltip'

/**
 * 复制按钮：写入剪贴板后 1500ms 内显示对勾反馈。
 * 两种形态：
 * - showText：代码块 / Mermaid 顶栏用法 —— Copy/Copied 文字 + 带 strokeWidth 的 w-3.5 图标
 * - 仅图标：聊天气泡代码块 —— 无文字、无 strokeWidth，样式全靠 className
 */
export function CopyButton({
  text,
  className,
  ariaLabel,
  title,
  showText = false,
  iconClassName = 'w-3.5 h-3.5',
}: {
  /** 要复制到剪贴板的文本 */
  text: string
  className?: string
  /** 未复制时的 aria-label；复制成功期间固定为 'Copied'。不传则不渲染 aria-label */
  ariaLabel?: string
  title?: string
  /** 是否渲染 Copy / Copied 文字（顶栏用法）；文字模式下图标带 strokeWidth */
  showText?: boolean
  /** 图标尺寸类名 */
  iconClassName?: string
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const btn = (
    <button
      type="button"
      onClick={handleCopy}
      className={className}
      aria-label={ariaLabel ? (copied ? t('copyBtn.copied') : ariaLabel) : undefined}
    >
      {copied ? (
        <>
          <Check className={iconClassName} strokeWidth={showText ? 2 : undefined} />
          {showText && <span>{t('copyBtn.copied')}</span>}
        </>
      ) : (
        <>
          <Copy className={iconClassName} strokeWidth={showText ? 1.75 : undefined} />
          {showText && <span>{t('copyBtn.copy')}</span>}
        </>
      )}
    </button>
  )
  return title ? <Tooltip label={title}>{btn}</Tooltip> : btn
}
