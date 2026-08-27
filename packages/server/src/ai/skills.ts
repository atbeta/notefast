/**
 * 聊天面板预置问题
 *
 * 按是否打开文档分两套：问当前篇 / 问整库。卡片用书面短标题，
 * 点下去当用户消息发出；不把工具 SOP 塞进输入框。
 * 维护类活（收集箱归类、归档、周回顾）不放这里——那些是列表页的事。
 *
 * GET /ai/skills?scope=doc|all
 */

export type SkillScope = 'doc' | 'all'

export interface AiSkill {
  id: string
  name: string
  description: string
  /** lucide 图标名（web 侧映射渲染） */
  icon: string
  /** 点击后作为用户消息发出 */
  prompt: string
}

function zhDocSkills(): AiSkill[] {
  return [
    {
      id: 'summarize-doc',
      name: '总结当前文档',
      description: '概括本文要点；检索不足时读取全文',
      icon: 'file-text',
      prompt: '请总结当前正在查看的文档。以正文为准，检索片段不够则读取全文。不要编造正文里没有的内容。',
    },
    {
      id: 'related-notes',
      name: '查找相关笔记',
      description: '在知识库中检索与本文相关的笔记',
      icon: 'link',
      prompt: '请在知识库中查找与当前文档相关的笔记。列出并简要说明关联理由，引用原文。若无相关笔记，直接说明。',
    },
  ]
}

function enDocSkills(): AiSkill[] {
  return [
    {
      id: 'summarize-doc',
      name: 'Summarize current document',
      description: 'Summarize this document; read the full text if snippets are insufficient',
      icon: 'file-text',
      prompt: 'Please summarize the document I am currently viewing. Rely on the body text; read the full document if retrieval snippets are insufficient. Do not invent anything that is not in the document.',
    },
    {
      id: 'related-notes',
      name: 'Find related notes',
      description: 'Search the library for notes related to this document',
      icon: 'link',
      prompt: 'Please find notes in the library related to the current document. List them with a brief reason and citations. If none, say so.',
    },
  ]
}

function zhAllSkills(): AiSkill[] {
  return [
    {
      id: 'recent-notes',
      name: '回顾近期笔记',
      description: '列出近七日更新的笔记并各作一句概述',
      icon: 'clock',
      prompt: '请列出近 7 日更新的笔记。使用 notefast_list_docs（updated_within="7d"、status="all"），并为每篇写一句概述。不要仅凭检索片段编造标题。',
    },
    {
      id: 'inbox-overview',
      name: '查看收集箱',
      description: '概述收集箱中尚未整理的素材',
      icon: 'inbox',
      prompt: '请概述收集箱中的笔记。使用 notefast_list_docs（status="inbox"），每篇一句。仅概述，不要修改、打标签或删除。',
    },
  ]
}

function enAllSkills(): AiSkill[] {
  return [
    {
      id: 'recent-notes',
      name: 'Review recent notes',
      description: 'List notes updated in the last 7 days, one-sentence overview each',
      icon: 'clock',
      prompt: 'Please list notes updated in the last 7 days. Call notefast_list_docs with updated_within="7d" and status="all", and write a one-sentence overview for each. Do not invent titles from retrieval snippets.',
    },
    {
      id: 'inbox-overview',
      name: 'Review inbox',
      description: 'Overview captures that have not been filed as notes',
      icon: 'inbox',
      prompt: 'Please overview the notes currently in the inbox. Call notefast_list_docs with status="inbox" and summarize each in one sentence. Overview only — do not edit, tag, or delete.',
    },
  ]
}

export function listSkills(lang: 'zh' | 'en' = 'zh', scope: SkillScope = 'all'): AiSkill[] {
  const en = lang === 'en'
  if (scope === 'doc') return en ? enDocSkills() : zhDocSkills()
  return en ? enAllSkills() : zhAllSkills()
}

export function parseSkillScope(raw: string | undefined): SkillScope {
  return raw === 'doc' ? 'doc' : 'all'
}
