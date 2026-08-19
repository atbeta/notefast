/**
 * 内置技能（Skill）注册表
 *
 * 定位：笔记工具自己的活——整理、回顾、归档建议。
 * 形态就是「写好的 prompt + 现有工具组合」，不引入 skill 运行时；
 * 执行仍走 chat 的 agent loop。写工具会立即落库（文档历史可回退），
 * 因此技能文案必须强调「先建议、等确认」——不能指望运行时再拦一次。
 *
 * GET /ai/skills 下发给 Web 聊天面板渲染快捷入口；
 * prompt 中的 {{today}} / {{week_start}} 在服务端下发时插值。
 * 列表类技能必须点名 notefast_list_docs + notefast_read_doc：
 * 首轮 RAG 会拿整段技能 prompt 去检索，片段与收集箱/过时列表无关。
 */

export interface AiSkill {
  id: string
  name: string
  description: string
  /** lucide 图标名（web 侧映射渲染） */
  icon: string
  /** 点击后填入聊天输入框的 prompt 模板 */
  prompt: string
}

function zhSkills(): AiSkill[] {
  return [
    {
      id: 'inbox-triage',
      name: '整理收集箱',
      description: '逐条查看收集箱，建议归类、打标签、合并或丢弃',
      icon: 'inbox',
      prompt: `请帮我整理收集箱。
步骤：
1. 调用 notefast_list_docs，参数必须是 status="inbox"、limit=50（不要漏传 status：默认 note 不含收集箱）。
2. 对列出的文档并行调用 notefast_read_doc 读全文（一轮可多个；不要用检索片段代替正文）。超过 10 篇时先处理前 10 篇。
3. 忽略对话开始时附带的检索片段，以工具返回的列表和正文为准。
然后给出处理建议：
- 值得保留的：建议归入正式笔记，并建议合适的标签
- 内容重复或已被其他笔记覆盖的：建议删除，说明与哪篇重复
- 过时或没有价值的：建议丢弃
先列出完整建议清单，等我确认后再执行操作，不要直接修改。`,
    },
    {
      id: 'archive-suggest',
      name: '归档建议',
      description: '找出长期未更新、可能已过时的文档，建议归档',
      icon: 'archive',
      prompt: `请帮我找出可以归档的文档。今天日期：{{today}}。
步骤：
1. 调用 notefast_list_docs，参数 stale_within="30d"、status="note"、limit=50（stale_within 只能是 30d 或 90d）。
2. 对候选文档并行调用 notefast_read_doc 读全文，再判断哪些已经过时（已解决的问题记录、已完成的计划、失效的方案）。
3. 忽略对话开始时附带的检索片段；不要把本段指令当作检索词。
输出建议归档清单，每篇附上：标题、最后更新时间、建议归档的理由。只列建议，不要直接修改任何文档，等我逐条确认。`,
    },
    {
      id: 'weekly-review',
      name: '周期回顾',
      description: '回顾最近 7 天记录的笔记，生成摘要与跟进项',
      icon: 'calendar',
      prompt: `请帮我做一份本周回顾。今天日期：{{today}}（最近 7 天起点：{{week_start}}）。
步骤：
1. 调用 notefast_list_docs，参数 updated_within="7d"、status="all"、limit=50（updated_within 只能是 24h 或 7d；不要对 search_more 的 since 传 7d）。
2. 对列出的文档并行调用 notefast_read_doc 读全文。
3. 忽略对话开始时附带的检索片段。若还要用 notefast_search_more，query 必须是简短主题词，since 用 ISO 日期 {{week_start}}，不要把本段指令当 query。
然后：
1. 按主题归纳这周记录的内容
2. 指出值得跟进的待办或悬而未决的问题
3. 如果某条笔记明显可以补充完善，提出来
回顾生成后，问我要不要保存为一篇新笔记。`,
    },
  ]
}

function enSkills(): AiSkill[] {
  return [
    {
      id: 'inbox-triage',
      name: 'Triage inbox',
      description: 'Go through the inbox and suggest sorting, tagging, merging or discarding',
      icon: 'inbox',
      prompt: `Please help me triage my inbox.
Steps:
1. Call notefast_list_docs with status="inbox" and limit=50 (do not omit status: the default "note" excludes the inbox).
2. Call notefast_read_doc in parallel for each listed document (multiple calls in one round; do not substitute retrieval snippets for the full text). If there are more than 10, start with the first 10.
3. Ignore the retrieval snippets attached at the start of the conversation; rely on the tool results.
Then suggest what to do:
- Worth keeping: suggest promoting to a regular note, plus suitable tags
- Duplicated or already covered by another note: suggest deleting, and say which note it duplicates
- Outdated or low-value: suggest discarding
List the full set of suggestions first, then wait for my confirmation — don't modify anything directly.`,
    },
    {
      id: 'archive-suggest',
      name: 'Archive suggestions',
      description: 'Find documents that haven\'t been updated in a long time and may be outdated',
      icon: 'archive',
      prompt: `Please find documents that can be archived. Today's date: {{today}}.
Steps:
1. Call notefast_list_docs with stale_within="30d", status="note", and limit=50 (stale_within must be 30d or 90d).
2. Call notefast_read_doc in parallel for the candidates and judge which content is outdated (e.g. resolved issue notes, completed plans, superseded approaches).
3. Ignore the retrieval snippets attached at the start of the conversation; do not use this instruction as a search query.
Output a suggested archive list with, for each: title, last updated time, and the reason. Only list suggestions — don't modify any document directly; wait for my confirmation.`,
    },
    {
      id: 'weekly-review',
      name: 'Weekly review',
      description: 'Review notes from the last 7 days and generate a summary with follow-ups',
      icon: 'calendar',
      prompt: `Please create a weekly review. Today's date: {{today}} (start of the last 7 days: {{week_start}}).
Steps:
1. Call notefast_list_docs with updated_within="7d", status="all", and limit=50 (updated_within must be 24h or 7d; do not pass 7d as search_more's since).
2. Call notefast_read_doc in parallel for the listed documents.
3. Ignore the retrieval snippets attached at the start of the conversation. If you still call notefast_search_more, query must be short keywords and since must be the ISO date {{week_start}} — do not use this instruction as the query.
Then:
1. Group this week's entries by topic
2. Point out follow-ups or unresolved questions worth tracking
3. Flag any note that could clearly be expanded or improved
After generating the review, ask me whether to save it as a new note.`,
    },
  ]
}

/** 下发给客户端的技能列表（按语言 + 插值 {{today}} / {{week_start}}） */
export function listSkills(lang: 'zh' | 'en' = 'zh'): AiSkill[] {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return (lang === 'en' ? enSkills() : zhSkills())
    .map((s) => ({
      ...s,
      prompt: s.prompt.replaceAll('{{today}}', today).replaceAll('{{week_start}}', weekStart),
    }))
}
