/**
 * 内置技能（Skill）注册表
 *
 * 定位：笔记工具自己的活——整理、回顾、归档建议。
 * 形态就是「写好的 prompt + 现有工具组合」，不引入 skill 运行时；
 * 执行仍走 chat 的 agent loop，写操作由用户在对话中确认（建议模式）。
 *
 * GET /ai/skills 下发给 Web 聊天面板渲染快捷入口；
 * prompt 中的 {{today}} 在服务端下发时插值（供 LLM 计算时间窗）。
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
      prompt: `请帮我整理收集箱。先调用 notefast_list_docs（status=inbox）列出所有收集箱文档，逐条阅读后给出处理建议：
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
      prompt: `请帮我找出可以归档的文档。调用 notefast_list_docs（stale_within=30d）找出长期未更新的文档，再结合检索判断哪些内容已经过时（比如已解决的问题记录、已完成的计划、失效的方案）。
输出建议归档清单，每篇附上：标题、最后更新时间、建议归档的理由。只列建议，不要直接修改任何文档，等我逐条确认。今天日期：{{today}}。`,
    },
    {
      id: 'weekly-review',
      name: '周期回顾',
      description: '回顾最近 7 天记录的笔记，生成摘要与跟进项',
      icon: 'calendar',
      prompt: `请帮我做一份本周回顾。今天日期：{{today}}。调用 notefast_search_more 用 since 时间窗检索最近 7 天创建或更新的笔记（可分多次检索覆盖不同主题），然后：
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
      prompt: `Please help me triage my inbox. First call notefast_list_docs (status=inbox) to list all inbox documents, then read each one and suggest what to do:
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
      prompt: `Please find documents that can be archived. Call notefast_list_docs (stale_within=30d) to find documents not updated for a long time, then judge which content is outdated (e.g. resolved issue notes, completed plans, superseded approaches).
Output a suggested archive list with, for each: title, last updated time, and the reason. Only list suggestions — don't modify any document directly; wait for my confirmation. Today's date: {{today}}.`,
    },
    {
      id: 'weekly-review',
      name: 'Weekly review',
      description: 'Review notes from the last 7 days and generate a summary with follow-ups',
      icon: 'calendar',
      prompt: `Please create a weekly review. Today's date: {{today}}. Call notefast_search_more with a since time window to retrieve notes created or updated in the last 7 days (you can run several searches to cover different topics), then:
1. Group this week's entries by topic
2. Point out follow-ups or unresolved questions worth tracking
3. Flag any note that could clearly be expanded or improved
After generating the review, ask me whether to save it as a new note.`,
    },
  ]
}

/** 下发给客户端的技能列表（按语言 + 插值 {{today}}） */
export function listSkills(lang: 'zh' | 'en' = 'zh'): AiSkill[] {
  const today = new Date().toISOString().slice(0, 10)
  return (lang === 'en' ? enSkills() : zhSkills())
    .map((s) => ({ ...s, prompt: s.prompt.replaceAll('{{today}}', today) }))
}
