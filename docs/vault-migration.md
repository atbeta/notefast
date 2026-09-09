# 从 SQLite notebook 迁到 vault mode

> 决策依据：RFC 0001 D7。本文档已在 0.86.1 实例上实测走通一遍（2026-09-09，macOS / Bun 1.3.14），
> 步骤与「实测发现」都是真实结果，不是设想。

vault mode 不做原地转换：`kind='db'` 的库不会被「升级」成 vault。迁移 = 把旧库导出成 Markdown 文件夹，
再用一个新的 `DATA_DIR` 以 vault 模式启动。旧实例原样保留，随时可回退。

## 会保留什么、会丢什么

| 项目 | 结果（实测） |
|---|---|
| 正文、标题、标签 | 保留。标题 = 文件名，标签在 frontmatter `tags:` |
| 创建时间 | 保留（frontmatter `created` → 文档创建时间） |
| 修改时间 | frontmatter `modified` 保留但**不随写回刷新**；文件系统 mtime 才是权威 |
| 图片 | 归档 zip 含 `media/`；搬进 vault 的 `assets/` 后由 `GET /api/v1/vault/raw/*` 直出（相对路径按文件所在目录解析） |
| Obsidian 块 id（`^abc123`） | 保留，落进块 `properties.obsidian_block_id`，写回原样还原 |
| 文档 id、块 id | **全部重建**。frontmatter 里的 `notefast_id` 被忽略（但会原样留在文件里） |
| 引用（`block_refs`） | `[[wikilink]]` 在 ingest 时按文件名重新解析；指向已不存在笔记的链接进 `vault_unresolved_links` |
| AutoLink / 实体 / 向量索引 | 丢失，新库重新分析 / 重建（配置了 embedding 时对账后自动跑） |
| 修订历史、整篇快照 | 丢失（vault 模式下历史交给 git） |
| 分享链接 | 丢失，需重新开启 |
| 收集箱 / `ai_exclude` 状态 | **丢失**：导出档不写 `notefast_status` / `notefast_ai_exclude`，迁移后一律 `note` 且对 AI 可见。需要保留的文档请在 vault 里手动补 frontmatter |

## 步骤

### 1. 导出旧库（旧实例保持运行）

```bash
curl -H "Authorization: Bearer $API_TOKEN" -o notefast-archive.zip \
  http://localhost:3140/api/v1/export/archive
```

zip 结构：`<首标签|untagged>/<slug>--<docId12>.md` + `media/<sha><ext>` + `notefast-archive.manifest.json`。
slug 由标题生成（空格 → `-`，去掉文件系统保留字符）。

### 2. 解压（macOS 别用系统 unzip）

```bash
mkdir -p ~/Notes && ditto -x -k notefast-archive.zip ~/Notes
# Linux / GNU unzip：unzip -O UTF-8 notefast-archive.zip -d ~/Notes
```

**实测坑**：macOS 自带 `unzip` 不认 zip 的 UTF-8 文件名标志位（bit 11），中文名会变成乱码并写入失败
（`Illegal byte sequence`）。用 `ditto -x -k`（系统自带）或 GNU `unzip -O UTF-8` 即可。

### 3. 整理成 vault 文件夹

```bash
cd ~/Notes
rm -f notefast-archive.manifest.json
mv media assets
# 图片引用同步改：文档里的相对路径是 ../media/xxx
find . -name '*.md' -exec sed -i '' 's|](\.\./media/|](../assets/|g' {} +   # GNU sed 去掉 -i '' 的空串
# 去掉文件名里的 --<docId12> 后缀（文件名即标题）
find . -name '*--*.md' -print0 | while IFS= read -r -d '' f; do
  mv "$f" "$(dirname "$f")/$(basename "$f" | sed 's/--[0-9a-f]\{12\}\.md$/.md/')"
done
```

同名冲突检查（同一目录下会互相覆盖）：

```bash
find . -name '*.md' | sed 's|--[0-9a-f]\{12\}\.md$|.md|' | sort | uniq -d
```

文件夹层级随意，vault 只认「一个 `.md` 一篇文档」；标签来自 frontmatter，不来自目录名。
图片引用 `../assets/` 依赖「文档在子目录里」这一层，所以**不要**把文档平铺到 vault 根目录，除非同步改路径。

**实测坑：slug 与 H1 不一致**。导出文件名是 slug（空格变 `-`），正文首行是 `# 原标题`，
`stripTitleHeading` 只在两者完全相同时才剥掉 H1，因此 `迁移测试 A` 会多出一个同名 heading 块。
想彻底干净，可以在整理时用 H1 当文件名：

```bash
for f in $(find . -name '*.md'); do
  t=$(sed -n 's/^# \(.*\)$/\1/p' "$f" | head -1)
  [ -n "$t" ] && [ "$t.md" != "$(basename "$f")" ] && mv "$f" "$(dirname "$f")/$t.md"
done
```

### 4. 以 vault 模式启动新实例

```bash
VAULT_PATH=~/Notes DATA_DIR=./data-vault PORT=3141 bun --filter @notefast/server dev
# Docker：-v ~/Notes:/vault -e VAULT_PATH=/vault -v ./data-vault:/app/data
```

vault 模式下 `DATA_DIR` 是索引的**父目录**：实际索引落在 `./data-vault/<sha256(~/Notes) 前 12 位>/`，
一个 vault 一个索引；`data/*.json` 里的可复用配置也放在这个父目录（见第 5 步）。
Docker 上 watcher 后端启动时自动探测（bind mount 不投递 inotify → 自动轮询），无需手动设 `VAULT_USE_POLLING`。

启动日志出现 `📂 vault 对账完成: N 文件，+N …` 即完成；`GET /api/v1/vault/status` 看 `files` 与 `last_reconcile`。
**实测**：5 篇文档首次对账 52ms；`status.files=5`、`last_reconcile.created=5`。

### 5. 复制可复用的配置（可选）

`data/*.json`（AI 提供方、备份、存储位置、偏好、图床、术语词典）可直接拷到新 `DATA_DIR`；
**不要**拷 `notefast.db` / `media/`。

### 6. 验证

- Cmd+K 搜几个关键词；
- `GET /api/v1/docs/:id` 能看到 `vault_path`；
- 在 Obsidian / 编辑器里改一篇，几百毫秒后可搜（**实测 382ms**，含 300ms 稳定性窗口）；
- 在 NoteFast 里改一段，文件被就地改写、frontmatter 与未动块逐字节保留（实测通过）；
- `git init ~/Notes && git add -A && git commit`，之后 NoteFast 的写回都能 `git diff` 看见。

### 7. 多端同步（可选）

迁移完成后，同一份 vault 在第二台设备上不需要再导出一次：两台设备都指向**同一个存储连接**即可
（设置 → Vault → 文件同步；S3 / WebDAV / 本地目录）。它同步的是文件本身，索引在每台设备各自重建。

```bash
curl -X PUT http://localhost:3140/api/v1/vault/sync/config \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"locationId":"my-s3","prefix":"notefast-vault/","intervalSeconds":60}'
```

注意：**不要再叠加 iCloud / Dropbox / Syncthing**（双重同步会让文件互相删，面板会给出提示）；
冲突不会静默合并，旧版本会留成 `<name>.notefast-conflict-<device>-<时间>.md`。
设计与实测见 [RFC 0004](rfcs/0004-vault-file-sync.md)。

## 回退

新实例只是一份派生索引：停掉它、删掉 `data-vault/` 即回到原状；`~/Notes` 里的文件是你的，
继续用旧实例或任何编辑器都行。
