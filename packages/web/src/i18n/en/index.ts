import common from './common.json'
import settings from './settings.json'
import doc from './doc.json'
import routes from './routes.json'
import graph from './graph.json'
import aichat from './aichat.json'
import chrome from './chrome.json'
import panels from './panels.json'
import editor from './editor.json'
import util from './util.json'
import errors from './errors.json'

/** 深度合并（与 zh-CN/index.ts 同一实现，保证各语言包结构一致） */
function deepMerge(...objs: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const obj of objs) {
    for (const [k, v] of Object.entries(obj)) {
      const isPlain = (x: unknown): x is Record<string, unknown> =>
        typeof x === 'object' && x !== null && !Array.isArray(x)
      if (isPlain(v) && isPlain(out[k])) {
        out[k] = deepMerge(out[k], v)
      } else {
        out[k] = v
      }
    }
  }
  return out
}

/** 英语语言包（English） */
export default deepMerge(common, settings, doc, routes, graph, aichat, chrome, panels, editor, util, errors)
