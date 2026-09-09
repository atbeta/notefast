//! 「最近打开的 vault」（壳侧记忆）
//!
//! 只存路径：索引位置（DATA_DIR）由 engine 按 `sha256(vault 路径)` 派生，
//! 壳不复制这条规则（RFC 0001 D4 的口径在 `packages/server/src/native/bootstrap.ts`）。
//!
//! 存放位置：`<壳数据目录>/recent-vaults.json`（与 `ui-preferences.json` 同目录），
//! 与 engine 的 DATA_DIR 无关——切到 vault 模式后壳自己的配置仍在这里。

use std::path::Path;

/// 上限：菜单/启动页只展示前几条，存太多没意义
pub const MAX_ENTRIES: usize = 10;
const FILE_NAME: &str = "recent-vaults.json";

/// 路径规范化：存在则取 canonicalize（与 engine 侧 realpath 同口径，去符号链接差异），
/// 否则只去尾部分隔符（文件夹被删后仍能显示历史条目）
pub fn normalize(path: &str) -> String {
    let trimmed = path.trim();
    let base = trimmed.trim_end_matches(['/', '\\']);
    let base = if base.is_empty() { trimmed } else { base };
    match std::fs::canonicalize(base) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => base.to_string(),
    }
}

/// 去重键：Windows 卷默认大小写不敏感，同一文件夹不应出现两次
pub fn comparison_key(path: &str) -> String {
    normalize(path).to_lowercase()
}

/// 纯函数：置顶 + 去重（保留最新写法）+ 截断
pub fn merge(existing: &[String], path: &str, limit: usize) -> Vec<String> {
    let head = normalize(path);
    let mut out = Vec::with_capacity(limit.min(existing.len() + 1));
    let mut seen = Vec::new();
    for candidate in std::iter::once(head).chain(existing.iter().cloned()) {
        if candidate.is_empty() {
            continue;
        }
        let key = comparison_key(&candidate);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(candidate);
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// 解析 recent-vaults.json（JSON 字符串数组；非法内容当空列表，不抛错）
pub fn parse(raw: &str) -> Vec<String> {
    let paths: Vec<String> = serde_json::from_str::<Vec<String>>(raw).unwrap_or_default();
    paths.into_iter().filter(|p| !p.trim().is_empty()).collect()
}

pub fn read(data_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(data_dir.join(FILE_NAME))
        .map(|raw| parse(&raw))
        .unwrap_or_default()
}

pub fn write(data_dir: &Path, entries: &[String]) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("无法创建数据目录 {}: {e}", data_dir.display()))?;
    let raw = serde_json::to_string_pretty(entries).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(data_dir.join(FILE_NAME), raw)
        .map_err(|e| format!("写入 {FILE_NAME} 失败: {e}"))
}

/// 记一次打开（读 → 置顶去重 → 写），返回新列表
pub fn remember(data_dir: &Path, path: &str) -> Vec<String> {
    let next = merge(&read(data_dir), path, MAX_ENTRIES);
    if let Err(e) = write(data_dir, &next) {
        eprintln!("[notefast] 记录最近 vault 失败: {e}");
    }
    next
}

/// 从列表移除（文件夹被删 / 用户清理），返回新列表
pub fn forget(data_dir: &Path, path: &str) -> Vec<String> {
    let key = comparison_key(path);
    let next: Vec<String> = read(data_dir)
        .into_iter()
        .filter(|p| comparison_key(p) != key)
        .collect();
    if let Err(e) = write(data_dir, &next) {
        eprintln!("[notefast] 更新最近 vault 失败: {e}");
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nf-vault-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn normalize_strips_trailing_separator() {
        let dir = temp_dir("norm");
        let with_slash = format!("{}/", dir.display());
        assert_eq!(normalize(&with_slash), normalize(&dir.to_string_lossy()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn comparison_key_is_case_insensitive() {
        assert_eq!(
            comparison_key("C:\\Users\\X\\Vault"),
            comparison_key("c:\\users\\x\\vault")
        );
    }

    #[test]
    fn merge_promotes_dedupes_and_caps() {
        let existing = vec!["/a".to_string(), "/b".to_string(), "/c".to_string()];
        assert_eq!(merge(&existing, "/b", 10), vec!["/b", "/a", "/c"]);
        assert_eq!(merge(&existing, "/d", 3), vec!["/d", "/a", "/b"]);
        assert_eq!(merge(&[], "/a", 10), vec!["/a"]);
    }

    #[test]
    fn parse_ignores_garbage() {
        assert_eq!(parse(r#"["/a","/b"]"#), vec!["/a", "/b"]);
        assert!(parse("not-json").is_empty());
        assert!(parse(r#"{"a":1}"#).is_empty());
        assert_eq!(parse(r#"["", "/a"]"#), vec!["/a"]);
    }

    #[test]
    fn remember_read_forget_roundtrip() {
        let dir = temp_dir("roundtrip");
        let a = dir.join("VaultA");
        let b = dir.join("VaultB");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let list = remember(&dir, &a.to_string_lossy());
        assert_eq!(list.len(), 1);
        let list = remember(&dir, &b.to_string_lossy());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], normalize(&b.to_string_lossy()));
        // 再记一次 A：置顶，不重复
        let list = remember(&dir, &a.to_string_lossy());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], normalize(&a.to_string_lossy()));

        assert_eq!(read(&dir), list);
        let list = forget(&dir, &a.to_string_lossy());
        assert_eq!(list, vec![normalize(&b.to_string_lossy())]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
