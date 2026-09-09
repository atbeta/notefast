# vault-poc — 独立 chokidar 监听器

验证 vault mode 最小闭环：**vault 文件变更 → SQLite 索引更新**。

## 运行

```bash
# 1. 启动 NoteFast server
bun --filter @notefast-next/server dev

# 2. 在另一个终端准备 vault 目录
mkdir -p ./test-vault
echo "# My First Note" > ./test-vault/hello.md

# 3. 跑 PoC
NF_TOKEN=<your-token-from-settings-page> \
  VAULT_PATH=./test-vault \
  bun run tools/vault-poc/chokidar-demo.ts

# 4. 在第三个终端编辑文件
echo "## Added a section" >> ./test-vault/hello.md
echo "More content" >> ./test-vault/hello.md

# 5. 观察 PoC 输出 + 在 NoteFast UI 里 Cmd+K 搜 "Added"
```

## 设计

不依赖 vault 骨架代码（`packages/server/src/vault/`），独立 200 行。直接 POST 现有的 `/api/v1/import/markdown` 端点。

去重通过 `source = { provider: "vault-watcher", external_id: <rel-path> }`：
- 同 path + 内容未变 → 服务端返回 200 deduplicated（main v0.79 已实现）
- 同 path + 内容变了 → 新建 doc，source 锚点迁过去（main v0.79 已实现）

block ID 稳定性在 save 路径上由 main v0.86.1 的 `blockAlign.ts` + `markdownChildSync.ts` 保证——vault 模式无需重做这部分。

## 验证目标

按 RFC 0002 的标准：

| 指标 | 验证方法 |
|---|---|
| 文件变更延迟到 UI 可见 | PoC 输出时间 vs NoteFast Cmd+K 结果时间 |
| 内容未变 dedup 命中率 | 观察 `[dedup]` vs `[new]` 比例 |
| 大量文件全量扫描 | `bun run tools/vault-poc/full-scan.ts`（TODO） |
| 微小编辑 block ID 保持 | 在 server SQLite 里对比 block.id |

## 不做的事

- 不写 SQLite（直接调 import 端点）
- 不处理 doc 删除（PoC 阶段只 warn）
- 不处理 wiki-link 解析
- 不处理 asset / 图片关联

这些是后续 PR 的范围。

## 已知坑

- macOS fsevents 在 Bun 上偶尔漏事件；如果 PoC 没触发，检查 `fs_events` 是否启用
- Windows 用 ReadDirectoryChangesW，可能延迟；调试时打开 `awaitWriteFinish`
- Obsidian 编辑时会产生 2-3 次 fs event（保存、frontmatter 写、autosave），靠 `awaitWriteFinish.stabilityThreshold=300` 合并
