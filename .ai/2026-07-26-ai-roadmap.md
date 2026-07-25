# NoteFast AI 路线图

> 2026-07-26 · AI 写作 + Agent 闭环完成后的现状与未来规划

## 当前实现总览

### 已完成（生产可用）

| 层级 | 能力 | 位置 |
|---|---|---|
| 基建 | 18 家 Provider Presets（CN/Global/Local） | `core/src/ai/presets.ts` |
| 基建 | AiRuntime 热重载 + 配置持久化 | `core/src/ai/runtime.ts`, `server/src/services/aiRuntime.ts` |
| 基建 | sqlite-vec + JSON 双后端向量存储 | `server/src/ai/vectorStore.ts`, `vectorStoreVec.ts` |
| 基建 | 向量索引自动创建/更新/删除 + stale 检测 | `server/src/ai/indexJobs.ts` |
| 检索 | FTS5 + Embedding RRF 融合检索 | `server/src/ai/hybridSearch.ts` |
| 检索 | 可选 Reranker（TEI 兼容） | `core/src/ai/runtime.ts` rerank() |
| 检索 | 语义搜索 API + MCP tool | `server/src/api/ai.ts` /search, `mcp/tools/aiChat.ts` |
| 对话 | RAG Chat（SSE 流式 + Agent Loop + tool calling） | `server/src/ai/chat.ts` |
| 对话 | 推理链拆分（`<think>` 标签解析） | `core/src/ai/thinkSplit.ts` |
| 对话 | 标题/摘要生成 | `core/src/ai/suggest.ts` |
| 写作 | Ctrl+Enter 续写（ghost text + Tab 接受） | `web/src/ai/useAiWriting.ts`, `web/src/components/editor/AiGhostOverlay.tsx` |
| 写作 | 6 种写作模式（continue/refine/translate/summarize/expand/shorten） | `core/src/ai/write.ts` |
| 写作 | 写作 SSE 端点到编辑器 | `server/src/ai/writeStream.ts` |
| 组织 | AutoLink — LLM 抽取实体 → 语义匹配 → 建议入库 | `server/src/ai/autoLink.ts` |
| 组织 | AI 软隔离（`ai_exclude` 全链路过滤） | `server/src/ai/aiExclude.ts`, `aiExcludeQuery.ts` |
| Agent | Chat 对话中创建笔记 + 追加内容 | `server/src/ai/chat.ts` (notefast_create_note, notefast_append_to_doc) |
| Agent | MCP 10 个 AI 工具全开放 | `server/src/mcp/tools/aiChat.ts`, `autoLink.ts` |
| UI | AI Chat 面板（SSE 流式 + 引用展示 + 思考块） | `web/src/components/AIChatPanel.tsx` |
| UI | AI 设置页（Provider 选择 + 连通测试 + 诊断） | `web/src/routes/settings-ai.tsx` |
| UI | AutoLink Inbox（建议审核面板） | `web/src/components/AutoLinkPanel.tsx` |

### 编辑器架构（已优化）

```
MarkdownEditor.tsx (252 行 orchestrator)
  ├── useEditorDraft          localStorage 草稿持久化
  ├── useEditorKeyboard       Ctrl+Enter 续写 + 快捷键
  ├── useImageUploader        粘贴/拖放上传
  ├── EditorToolbar           工具栏 UI
  ├── EditorFooter            状态栏
  ├── AiGhostOverlay          光标处流式 ghost text
  └── useAiWriting            写作 SSE 流 hook

useEditorContext             编辑器→AI 组件通信桥（未来 AiGhostOverlay 使用）
lib/streaming.ts             通用 SSE 流客户端
useKeyboardShortcuts         通用快捷键注册 hook
```

---

## 差距分析 vs AI-First 笔记产品

### P0 — AI 辅助写作 ✅ 已完成

- ✅ Ctrl+Enter 续写（ghost text + Tab 接受）
- ✅ 6 种写作模式 prompt 模板
- ⬜ 选区变换 popover（润色/翻译/总结/扩写/缩写 — prompt 已有，缺 UI）
- ⬜ Slash Commands（/summarize, /todo, /expand）

### P1 — Agent 能力闭环 ✅ 已完成

- ✅ Chat 对话中 `notefast_create_note`（创建新笔记）
- ✅ Chat 对话中 `notefast_append_to_doc`（追加到已有文档）
- ⬜ MCP Agent loop 中直接暴露写工具（当前写工具在 MCP docWrite 组，不参与 chat agent loop）
- ⬜ 定时触发器（每日摘要、Tag 聚合报告）
- ⬜ 批量操作（一次给多篇笔记加 tag、更新状态）

### P2 — 智能组织

- ⬜ AI 自动打标推荐
- ⬜ 相似文档发现 / 去重提醒
- ⬜ 智能收集箱分拣（收集箱内容自动推荐分类/归档位置）
- ⬜ 跨文档主题聚类

### P3 — 个性化与长期记忆

- ⬜ 用户偏好学习（隐式反馈排序）
- ⬜ 写作风格学习（few-shot 模板）
- ⬜ 长期对话记忆（跨会话画像）

### P4 — 多模态理解

- ⬜ 图片 OCR + 语义理解
- ⬜ Chart/表格解析
- ⬜ 音频转写 + 总结
- ⬜ PDF/网页抓取理解增强

---

## 架构原则（已建立的）

1. **键盘模态优先** — AI 能力通过 Ctrl+Enter 等快捷键触发，不是独立面板
2. **薄 UI 厚逻辑** — Ghost text overlay / popover 是极简视图，prompt 工程在 core 层
3. **所有 AI 能力先通过 API 暴露** — `/api/v1/ai/write`、`/api/v1/ai/chat` 均可被外部调用
4. **SSE 流式优先** — 写作/对话均用 SSE streaming，不阻塞 UI
5. **编辑器不依赖 AI** — AI 通过 EditorContext 挂载，编辑器核心不 import AI 代码

## 下一步建议

1. **P2 选区 popover**（小改动，prompt 已有）— 选中文本→Ctrl+Enter→润色/翻译/总结
2. **P2 Slash Commands**（/summarize /todo 等）— 编辑器内 AI 能力发现
3. **P3 相似文档发现** — 为每篇笔记生成摘要向量，做最近邻聚类
4. **P4 图片 OCR** — 对已上传图片做 OCR 写入向量索引
