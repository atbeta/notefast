/**
 * Bookmarklet 生成器（纯函数，供 CapturePanel 与单测使用）。
 * 生成的 javascript: 代码在任意网页上下文执行，把选区文本/页面链接
 * POST 进收集箱（POST /api/v1/import/markdown，source 去重语义见 docs/capture.md）。
 *
 * 注意：令牌明文会嵌入书签代码，面板侧必须引导用户使用可撤销的 api_tokens 令牌。
 */

export interface BookmarkletOptions {
  /** 实例地址，如 https://notes.example.com（尾部斜杠会被去掉） */
  endpoint: string
  /** api_tokens 令牌明文（需 read+write scopes） */
  token: string
  /** bookmarklet 内 alert 文案（默认中文；面板按 UI 语言传入） */
  labels?: { success: string; failure: string }
}

const DEFAULT_LABELS = { success: '已收集到 NoteFast 收集箱', failure: 'NoteFast 收集失败' }

/** 采集 URL 规范化：去 hash、去 utm_* 跟踪参数（其余参数保留）；非法 URL 原样返回 */
export function normalizeClipUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key)) u.searchParams.delete(key)
    }
    return u.toString()
  } catch {
    return raw
  }
}

/**
 * 生成 javascript: 书签代码（单行）。
 * 行为：有选区 → 正文为「引用块 + 页面链接」；无选区 → 仅页面链接。
 * source 固定 provider 'web-clipper'，external_id 为规范化 URL（与端内去重约定一致）。
 */
export function buildBookmarkletCode({ endpoint, token, labels = DEFAULT_LABELS }: BookmarkletOptions): string {
  const ep = endpoint.replace(/\/+$/, '')
  // JSON.stringify 产出的字面量可安全嵌入 JS 代码（引号/转义已处理）
  const epLit = JSON.stringify(ep)
  const tokenLit = JSON.stringify(token)
  const okLit = JSON.stringify(labels.success)
  const failLit = JSON.stringify(labels.failure)
  return [
    'javascript:(async()=>{',
    `const E=${epLit},T=${tokenLit};`,
    // 与 normalizeClipUrl 同规则的页面侧实现（bookmarklet 自带，无外部依赖）
    `let u=location.href;try{const x=new URL(location.href);x.hash='';for(const k of [...x.searchParams.keys()])if(/^utm_/i.test(k))x.searchParams.delete(k);u=x.toString()}catch(e){}`,
    `const s=(window.getSelection()?.toString()||'').trim();`,
    `const title=document.title||u;`,
    `const link='['+title+']('+u+')';`,
    `const md=s?'> '+s.split('\\n').join('\\n> ')+'\\n\\n'+link:link;`,
    `const r=await fetch(E+'/api/v1/import/markdown',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify({markdown:md,title,status:'inbox',source:{provider:'web-clipper',external_id:u}})});`,
    `alert(r.ok?${okLit}:${failLit}+' HTTP '+r.status)`,
    '})()',
  ].join('')
}
