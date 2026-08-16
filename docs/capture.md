# 外部采集（Capture）

把网页选区、页面链接或任意外部内容收进 NoteFast 收集箱（inbox）。所有通道共用一个端点，契约只做加法，是未来外部连接器（Readwise 类）的对接基础。

## 端点契约

```
POST /api/v1/import/markdown
Authorization: Bearer <api_token>
Content-Type: application/json
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `markdown` | ✓ | 正文（≤ 5MB） |
| `title` | | 缺省取首个 H1，否则「未命名文档」 |
| `status` | | `'inbox'`（收集箱）或 `'note'`，缺省 `'note'` |
| `tags` | | 字符串数组，入库前自动规范化（小写、空白转连字符） |
| `notebook_id` | | 缺省入第一个笔记本 |
| `source` | | `{ provider, external_id }`，见下节 |

响应：成功创建 `201 {doc, block_count, ...}`；去重命中 `200 {doc, deduplicated: true}`（零副作用）。

## source 与去重语义

`source` 是外部内容的身份。携带 source 的导入：

- **同 provider + external_id 且内容一致** → 200 去重返回既有文档，无任何副作用；
- **内容变了** → 新建一篇进收集箱，旧文档保留你的编辑、剥掉 source 成为普通笔记，source 锚定最新篇；
- 回收站里的旧导入不挡重新导入。

provider 命名约定（自取新名，勿复用）：

| provider | 通道 |
|---|---|
| `file-open` | web `/preview` 预览页「导入到 NoteFast」（原生壳 OS 文件打开走预览、不入库；用户在预览页显式导入时由 web 携带，已占用勿动） |
| `web-clipper` | 浏览器 bookmarklet |
| `ios-shortcut` | iOS 快捷指令 |

`external_id` 网页类通道统一用规范化 URL（去 hash、去 `utm_*` 跟踪参数）。

> 收集箱内容不参与 AutoLink 实体抽取/建链，升格为正式笔记（note）时自动补抽。

## 通道一：Bookmarklet（浏览器）

设置页「令牌」tab 底部的「采集」卡片可生成 bookmarklet：填实例地址、粘贴令牌，复制代码后在书签栏新建书签并粘贴为网址。在任意网页点击书签：

- 有选中文本 → 正文为「引用块 + 页面链接」；
- 无选中 → 正文为页面链接。

两个前提：

1. **CORS**：bookmarklet 在页面上下文跨域调用，实例需配置 `CORS_ORIGINS`（自托管一般设为 `*`）。
2. **令牌需要 write 权限**：`scopes` 仅 `read` 的令牌写请求会 403。

## 通道二：iOS 快捷指令

不经过浏览器，无 CORS 概念，配置好鉴权即可用：

1. 新建快捷指令，通过分享表单接收「URL」或「文本」；
2. 添加「获取 URL 内容」动作：方法 POST，地址 `<实例>/api/v1/import/markdown`，请求体类型 JSON；
3. 头部加 `Authorization: Bearer <令牌>`；正文 `markdown` 放内容、`status` 填 `inbox`、`source` 填 `{"provider":"ios-shortcut","external_id":"<页面URL>"}`。

参考 curl：

```bash
curl -X POST "https://your-host/api/v1/import/markdown" \
  -H "Authorization: Bearer nf_xxx" \
  -H "Content-Type: application/json" \
  -d '{"markdown":"正文内容","title":"...","status":"inbox","source":{"provider":"ios-shortcut","external_id":"https://example.com/page"}}'
```

## 通道三：任意 HTTP 客户端

同上 curl。大文件（>5MB）请走分块暂存通道（`notefast_stage_markdown` + `notefast_create_doc_from_file`，见 MCP 工具说明）。

## 安全须知

- **令牌明文**：bookmarklet 代码里嵌着令牌明文，任何能打开该书签的人都能以你的身份写入。务必使用设置页生成的**可撤销令牌**（api_tokens），不要用主 `API_TOKEN`；泄露时在令牌列表撤销即可。
- **`CORS_ORIGINS=*` + 免鉴权模式**：意味着任意网页可读写整个知识库——仅限本地/内网开发，公网部署绝不要这样组合。
- 采集令牌建议权限最小化（read+write，不给 admin）。
