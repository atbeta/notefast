# 从 SQLite notebook 迁到 vault mode

> 草稿。定稿任务见 `docs/plans/vault-mode.md` V-502。决策依据：RFC 0001 D7。

vault mode 不做原地转换：`kind='db'` 的库不会被「升级」成 vault。迁移 = 把旧库导出成 Markdown 文件夹，再用一个新的 `DATA_DIR` 以 vault 模式启动。旧实例原样保留，随时可回退。

## 会保留什么、会丢什么

| 项目 | 结果 |
|---|---|
| 正文、标题、标签 | 保留（标题 = 文件名，标签在 frontmatter `tags:`） |
| 创建 / 修改时间 | 保留在 frontmatter `created` / `modified`；ingest 读 `created` 作为文档创建时间 |
| 图片 | 归档 zip 含 `media/`；放进 vault 的 `assets/`，图片直出见计划 V-303 |
| 文档 id、块 id | **全部重建**。frontmatter 里的 `notefast_id` 被忽略 |
| 引用（block_refs）、AutoLink 结果 | 丢失；AutoLink 会在新库重新分析 |
| 向量索引 | 重建（配置了 embedding 的话对账后自动跑） |
| 修订历史、整篇快照 | 丢失（vault 模式下历史交给 git） |
| 分享链接 | 丢失，需重新开启 |
| 收集箱 / ai_exclude 状态 | 导出档目前不带；进入 vault 后在 frontmatter 用 `notefast_status` / `notefast_ai_exclude` 表达（V-202 落地后） |

## 步骤

1. **导出旧库**（旧实例保持运行）

   ```bash
   curl -H "Authorization: Bearer $API_TOKEN" -o notefast-archive.zip \
     http://localhost:3140/api/v1/export/archive
   ```

   zip 结构：`<首标签|untagged>/<slug>--<docId12>.md` + `media/` + `manifest.json`。

2. **整理成 vault 文件夹**

   ```bash
   mkdir -p ~/Notes && cd ~/Notes
   unzip ~/notefast-archive.zip
   rm manifest.json
   mv media assets                      # 可选；图片相对路径随后统一调整
   # 去掉文件名里的 --<id> 后缀（文件名即标题）
   find . -name '*--*.md' -exec sh -c 'mv "$1" "${1%--*}.md"' _ {} \;
   ```

   同名冲突（不同标签目录下同名文件不冲突；同目录下同名会覆盖，先检查）：

   ```bash
   find . -name '*.md' | sed 's|--[0-9a-f]\{12\}\.md$|.md|' | sort | uniq -d
   ```

   文件夹层级随意，vault 只认「一个 `.md` 一篇文档」；标签来自 frontmatter，不来自目录名。

3. **以 vault 模式启动新实例**

   ```bash
   VAULT_PATH=~/Notes DATA_DIR=./data-vault PORT=3141 bun --filter @notefast/server dev
   # Docker：-v ~/Notes:/vault -e VAULT_PATH=/vault -v ./data-vault:/app/data
   ```

   启动日志出现 `📂 vault 对账完成: N 文件，+N …` 即完成。`GET /api/v1/vault/status` 查看 `files` 与 `last_reconcile`。

4. **复制可复用的配置**（可选）

   `data/*.json`（AI 提供方、备份、存储位置、偏好、图床、术语词典）可直接拷到新 `DATA_DIR`；**不要**拷 `notefast.db` / `media/`。

5. **验证**：Cmd+K 搜几个关键词；在 Obsidian 里改一篇再搜；确认 `git init ~/Notes` 后 NoteFast 写回的改动能被 `git diff` 看见。

## 回退

新实例只是一份派生索引：停掉它、删掉 `data-vault/` 即回到原状；`~/Notes` 里的文件是你的，继续用旧实例或任何编辑器都行。
