/**
 * 新库种一篇「开始使用」：只在空白新库写入一次。
 * 已有 data/notefast.db 的实例不种；用户删光文档也不会再种。
 */

import { insertDocFromMarkdown } from './docImport'
import { countDocRows, type Db } from '../store/blocks'

export const WELCOME_DOC_TITLE = '开始使用'
export const WELCOME_DOC_TAG = 'guide'

const WELCOME_MARKDOWN = `NoteFast 没有笔记本。一篇文档就是一篇文档；分类靠**标签**，常用筛选可以固定到侧边栏。

## 先配置 AI

打开 [设置 → AI](/settings/ai)，填入对话模型和向量模型。不配也能写笔记、全文搜索；但语义搜索、实体、图谱、自动链接、⌘J 问答都不会工作——没有模型就还不是知识库。

## 用标签组织

给文档打标签。在首页点标签可以筛选；标题旁的星星会把当前筛选固定到侧栏「固定视图」。

收集箱用来随手记下，整理后再加入笔记。这篇看完可以删。
`

export function seedWelcomeDocIfNeeded(
  db: Db,
  notebookId: string,
  opts: { isNewDb: boolean },
): { seeded: boolean } {
  if (!opts.isNewDb) return { seeded: false }
  if (countDocRows(db) > 0) return { seeded: false }

  insertDocFromMarkdown(db, {
    notebookId,
    title: WELCOME_DOC_TITLE,
    markdown: WELCOME_MARKDOWN,
    tags: [WELCOME_DOC_TAG],
  })
  return { seeded: true }
}
