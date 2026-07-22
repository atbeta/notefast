# NoteFast 备份与 Markdown 归档

## 概念区分

| 能力 | 作用 | 覆盖范围 |
|------|------|----------|
| **数据库备份** | SQLite 一致快照 → S3 | 完整实例数据（blocks、refs、vectors、FTS、AutoLink 等） |
| **Markdown 归档** | 单向推送 `.md` | 仅正文结构；丢失 ID / 标签 / 引用 / 向量 |

完整灾备请使用数据库备份。Markdown 归档用于可读副本与内容主权，不能替代恢复。

## 数据库备份

### 配置

1. 打开 Web「设置 → 数据库备份」
2. 填写 S3 兼容存储（AWS / R2 / MinIO）
3. 设置间隔（默认 1 小时）与保留天数（默认 30）
4. 「测试连接」→「立即备份」

配置落盘：`data/backup.config.json`（权限尽量 `0600`）。密钥不会通过 API 明文回传；保存时传 `***set***` 表示沿用旧值。

### 快照流程

1. 互斥锁（禁止重叠）
2. `VACUUM INTO` 生成临时一致快照
3. `PRAGMA quick_check` + SHA-256
4. 上传唯一对象键 + `.manifest.json`
5. 按保留策略删除 NoteFast 管理的过期恢复点

### 恢复（停服务 + CLI）

**必须先停止 NoteFast**（Compose：`docker compose stop notefast`）。CLI 不做占用探测：WAL 下主动占写锁既不可靠，也可能干扰仍在运行的实例。

```bash
# 1. 停止 NoteFast
docker compose stop notefast   # 或等价操作

# 2. 预演（可选）
bun --filter @notefast/server backup:restore -- \
  --data-dir ./data \
  --object-key notefast-backup/snapshots/....db \
  --dry-run

# 3. 正式恢复（需 --yes）
bun --filter @notefast/server backup:restore -- \
  --data-dir ./data \
  --object-key notefast-backup/snapshots/....db \
  --yes

# 4. 启动服务
docker compose start notefast
```

恢复写入顺序：`write staging → fsync(file) → rename → fsync(dir)`，降低崩溃后得到空/残缺 `notefast.db` 的风险。
恢复前校验：manifest、SHA-256、`quick_check`、schema 版本（不得高于当前程序）。
现有 `notefast.db` / WAL / SHM 会移入 `data/rollback-<timestamp>/`。

Web **不提供**一键覆盖恢复。

## Markdown 归档

设置页「Markdown 归档」可选单一目标：LocalFS / S3 / WebDAV。

- 文件名：`<标题 slug>--<docId前缀>.md`
- 清单：`notefast-archive.manifest.json`（用于清理已删除/改名文档的陈旧文件）
- 定时任务状态写入 `lastRunAt` / `lastError` / `lastResult`

## 验收清单

- [ ] Web 配置 S3 后可立即备份，恢复点列表可见
- [ ] 停服 CLI 可从空目录恢复，文档与引用完整
- [ ] Markdown S3 / WebDAV 归档无同名覆盖；删除文档后陈旧文件被清理
- [ ] 脱敏密钥二次保存不会被写成字面量 `***set***`
