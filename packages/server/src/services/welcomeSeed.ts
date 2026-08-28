/**
 * 新库种一篇「开始使用」：只在空白新库写入一次。
 * 已有 data/notefast.db 的实例不种；用户删光文档也不会再种。
 */

import { insertDocFromMarkdown } from './docImport'
import { countDocRows, type Db } from '../store/blocks'

export const WELCOME_DOC_TITLE = '开始使用'
export const WELCOME_DOC_TAG = 'guide'

/** 新库种入正文。无 H1：标题走文档根，避免与正文标题块重复。 */
export const WELCOME_MARKDOWN = `NoteFast 是单本知识库：没有「笔记本」这层。一篇文档就是一篇文档；分类靠**标签**，常用筛选固定到侧栏，检索和 AI 按块工作。

侧栏从上到下是：笔记（所有文档，下面挂收集箱 / 归档 / 回收站 / 资源）→ 固定视图 → 关系 → 智能视图 → 最近访问。最近访问是本机打开过的足迹，和首页「最近更新」不是一回事。

## 写与读

文档默认是阅读态。\`⌘E\`（Windows 用 Ctrl）进入编辑，输入会自动保存；\`⌘S\` 保存并回到阅读。\`⌘N\` 新建，\`⌘P\` 在编辑里切预览。

块是写作单位：段落、标题、列表、引用各自一块。阅读态点块左侧手柄，或在块上右键，可以问 AI、复制。编辑时把光标放在已有文字后面，\`⌘Enter\` 续写，Tab 接受，Esc 取消。

图片直接粘贴或拖进编辑器即可。文件存在本机（内容寻址），正文里是 \`asset:…\` 引用，导出 zip 时会带上。

## 用标签组织

给文档打标签（这篇是 \`guide\`）。首页点标签筛选；多选默认要**同时**带这些标签。标题旁的星星会把当前筛选固定到侧栏「固定视图」——这就是常用工作区，不必再做多本笔记本。

智能视图是现成的债务清单：**90 天未更新**、**对 AI 隐藏**、**未加标签**。未加标签的文档会在侧栏显示数量，方便清掉。

[收集箱](/inbox) 给随手记下的素材、剪藏、草稿。整理后再「加入笔记」，才会出现在所有文档里。收集箱内容不参与实体抽取和向量索引。

## 搜索

\`⌘K\` 全局搜索：文档名、正文、命令。点一条命中会打开那篇文档并滚到对应块。\`⌘F\` 只在当前这篇里查找。

\`⌘K\` 一直是词法检索（中文按子串，英文按词）。语义检索走 \`⌘J\` 问库，要先配向量模型。问答里的引用栏会列出用到的块，点标记可跳到原文。

## 配置 AI

打开 [设置 → AI](/settings/ai)。**对话模型**管问答、续写、实体抽取；**向量模型**管语义检索；精排模型可选。新槽默认是空的自定义表单，不会替你预选云端厂商。

不配也能写笔记、用标签、做 \`⌘K\` 词法搜索。\`⌘J\`、实体、图谱、自动链接要对话模型；语义检索要向量模型。没配时这些入口会隐藏或禁用，不会变成报错墙。

\`⌘J\` 打开助手，问的是**你的库**，不是通用聊天。阅读态在块上「问 AI」会带上这一段。文档默认对 AI 可见；「对 AI 隐藏」只挡索引、MCP 发现和按 ID 读取，人类阅读、同步、备份仍带全文。

换过向量模型后，到设置 → AI 点一次**重建索引**。覆盖率看的是当前向量库，旧索引不会算进去。

## 导入、备份、外部接入

已有 Markdown / Word / 文本：到 [新建](/new) 页导入（也可直接把文件拖进去）。多篇或带图片用 zip。**通用 zip** 里每一层文件夹都会变成标签，最外层是第一枚；\`untagged/\`、\`media/\` 这类目录不打。从 NoteFast 导出去的档案再导回来，标签以文件头 YAML 为准，不再按目录补打。导出 Markdown 归档仍按**首标签**分一层目录（没有标签就进 \`untagged/\`）。

备份和归档是两件事，都在 [设置 → 备份与归档](/settings/backup)：

- **数据库备份**：SQLite 快照，灾备用。恢复要停服跑恢复命令，不要和日常写作混用。
- **Markdown 归档**：单向便携副本（本地盘 / S3 / WebDAV），会丢掉块 ID、引用等元数据，不能当完整还原。

外部 AI（Cursor、Claude Desktop 等）走 MCP：打开 [设置 → API 与外部接入](/settings/tokens)，生成令牌，把配置贴进客户端。Web 登录密码和 API 令牌是分开的；本地开发可以都不配。浏览器剪藏、快捷指令也走同一套采集接口，进收集箱。

这篇看完可以删。顶栏右侧的键盘图标会列出当前页可用的快捷键。
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
