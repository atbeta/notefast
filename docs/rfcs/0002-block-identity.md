# RFC 0002: block-identity — vault 模式下的稳定块标识

- 状态：草案
- 依赖：RFC 0001（vault-mode）
- 目标版本：NoteFast Next v0.1.0-next.0

## 摘要

定义 vault 模式下 block 的稳定标识算法。**用户的 `.md` 文件被外部工具修改后，索引重建时块 ID 要尽量保持稳定**，这样 RAG 引用、AI 生成的链接、AutoLink 不会因为微小的文字调整就全失效。

## 背景

main v0.86.1 已经实现的稳定性保证（仅在 save 路径上）：

- `blockAlign.ts` — 编辑保存时按指纹对齐旧/新块，未变块保持 ID
- `markdownChildSync.ts` — 把对齐结果应用到数据库

这个机制解决了**主路径**（NoteFast 编辑器 → SQLite）的稳定性。但 vault 模式引入了**第二条路径**（文件系统 → SQLite），需要类似保证：

```
用户在 Obsidian 里加一行字 → 文件变更 → watcher 触发 ingest → 
parse 出新 blocks → 怎么映射到现有 blocks → 怎么保持引用稳定？
```

## 标识设计

### 块 ID 格式

```
sha256(
  file_path        + "\x00" +   // vault 相对路径（保证文件身份稳定）
  heading_path     + "\x00" +   // "H1 > H2 > H3" 形式（保证就近编辑稳定）
  content_window   + "\x00"    // 块内容 + 上下 1 行（容忍小范围修改）
).substring(0, 32)
```

#### 各字段作用

| 字段 | 解决什么 |
|---|---|
| `file_path` | 跨文件身份隔离；重命名 = 一次性迁移 |
| `heading_path` | 段落在文档结构中的位置；加新 H1 不会让现有块失效 |
| `content_window` | 内容指纹；纯打字错误不影响 |

#### 漂移触发条件

只有以下情况 ID 会漂移：

1. 段落的 H1/H2 改了（heading_path 变）
2. 段落正文超过 ±1 行被改写（content_window 变）
3. 段落被移动到其他 H1 下

## 三层降级匹配

引用解析时，**永远尝试最严匹配**，失败则降级：

```
1. 精确 (file_path, block_hash)              ← 最严
2. (file_path, heading_slug)                 ← 块漂移但 heading 在
3. (file_path)                               ← 只剩文件名
4. (file_name, fuzzy_content_match)          ← 内容相似度匹配
5. 失败 → 显示 "broken link"，不抛错
```

这比 Obsidian 的 "this link is broken" 更宽容。

## 增量 ingest 流程

```typescript
// packages/server/src/vault/ingest.ts (sketch)

async function ingestFile(filePath: string): Promise<IngestResult> {
  const content = await readFile(filePath, 'utf8')
  const parsed = parseMarkdown(content)  // 复用 packages/core
  
  const oldBlocks = await fetchChildBlocks(docIdFor(filePath))
  const newInputs = parsed.children.map(blockToCreateInput)
  
  // 关键：用 planBlockAlign 但用新算法生成的 fingerprint
  const oldFps = oldBlocks.map(b => vaultFingerprint(filePath, b))
  const newFps = newInputs.map(b => vaultFingerprint(filePath, b))
  
  const ops = planBlockAlign(oldFps, newFps, ...)
  
  // 应用 diff（同 main 的 syncMarkdownChildren）
  return applyOps(ops, oldBlocks, newInputs)
}

function vaultFingerprint(filePath: string, block: BlockRow): string {
  const headingPath = resolveHeadingPath(filePath, block)
  const window = contentWindow(filePath, block, before=1, after=1)
  return sha256(`${filePath}\x00${headingPath}\x00${window}`).substring(0, 32)
}
```

## 边界条件

| 情况 | 处理 |
|---|---|
| 文件被删除 | 标记 doc 为 stale，30 天后真删（保留恢复窗口） |
| 文件被移动（rename） | 检测 vault 内 mv，迁移索引而不重建 |
| 文件大小 > 1MB | 流式 parse，不全读内存 |
| 文件含 frontmatter | 解析为 properties（继承 main 的实现） |
| 文件含 Obsidian `[[link]]` | 解析为 hint，索引时尝试建 block_refs |
| 文件含图片引用 | 解析 `![](assets/x.png)`，建立 asset 关联 |
| 同时多文件改动 | watcher 串行处理（避免 SQLite 写锁竞争） |

## 与现有 main 实现的复用

| main v0.86 | vault 模式如何复用 |
|---|---|
| `services/blockAlign.ts` | ✅ 直接复用 `planBlockAlign`、`fingerprintBlock`、`stablePropsJson` |
| `services/markdownChildSync.ts` | ✅ 直接复用对齐 + diff 应用逻辑 |
| `services/contentHash.ts` | ⚠️ 复用 Bun.CryptoHasher，但算法换（加 heading_path + content_window） |
| `services/shadowMarkdown.ts` | ❌ 方向相反，不能复用，但可借鉴 subscribeDocChanges 模式 |
| `core/markdownParse.ts` | ✅ 直接复用 Markdown → blocks 解析 |
| `store/blocks.ts` | ✅ 直接复用所有读写约定 |

实际新增代码量：

| 新增 | 行数估算 |
|---|---|
| `vault/identity.ts` | ~100 行（vaultFingerprint + headingPath 解析 + 内容窗） |
| `vault/ingest.ts` | ~150 行（串起 parse → align → apply） |
| `vault/watcher.ts` | ~80 行（chokidar 封装 + 事件队列） |
| `vault/index.ts` | ~50 行（注册入口） |
| 测试 | ~200 行 |
| **合计** | **约 580 行新增** |

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| heading_path 解析在嵌套 H1/H2 复杂结构下出错 | 引用漂移增多 | 用 mdast 的 heading 序列而非正则 |
| content_window 算法选 ±1 行可能不够 | 微小修改就漂移 | 提供可调参数；MVP 用 ±1，跑数据后调 |
| chokidar 触发风暴（编辑器保存时多次 fs event） | 重复 ingest | 用 awaitWriteFinish（main 已用过类似配置） |
| 大 vault 全量重建索引慢 | 首次体验差 | 后台渐进式，先返回部分结果 |

## 实施步骤

1. v0.1.0-next.0：`vaultFingerprint` 算法实现 + 单文件 ingest PoC
2. v0.1.0-next.1：watcher 集成，监听 vault 变更
3. v0.1.0-next.2：全量 vault 重建索引（CLI + API）
4. v0.1.0-next.3：性能调优，10k 文件 vault 验证

## 验证标准

| 指标 | 目标 |
|---|---|
| 微小编辑（< 5 字符）的 block ID 保持率 | > 95% |
| 中等编辑（< 1 段重写）的 block ID 保持率 | > 70% |
| 全文档重写的 block ID 保持率 | ~ 0%（正常） |
| 1000 文件 vault 首次全量索引时间 | < 60s |
| 文件变更到 SQLite 反映的端到端延迟 | < 500ms（不含 AI 重 embed） |

## 参考

- main v0.86 `services/blockAlign.ts` — 指纹算法基线
- main v0.86 `services/markdownChildSync.ts` — diff 应用基线
- Obsidian block reference 格式 `^block-id`
- Roam Research block ref 算法（content-based）
