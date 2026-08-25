//! 启动主题：读 data/ui-preferences.json，与 engine 注入的 __NF_PREFS 同源。
//! light/dark 用设置；未设或 system 才跟 OS。启动页读不到 engine origin 的 localStorage。

use std::path::Path;

/// splash 底色，对齐 ui/index.html 的 --bg
pub fn splash_rgb(is_dark: bool) -> (u8, u8, u8) {
    if is_dark {
        (0x15, 0x16, 0x1a)
    } else {
        (0xf4, 0xf5, 0xf9)
    }
}

pub fn parse_theme_choice(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    match v.get("theme")?.as_str()? {
        t @ ("light" | "dark" | "system") => Some(t.to_string()),
        _ => None,
    }
}

pub fn read_theme_pref(data_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(data_dir.join("ui-preferences.json")).ok()?;
    parse_theme_choice(&raw)
}

pub fn startup_is_dark(choice: Option<&str>, system_dark: bool) -> bool {
    match choice {
        Some("light") => false,
        Some("dark") => true,
        _ => system_dark,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_known_themes() {
        assert_eq!(parse_theme_choice(r#"{"theme":"dark"}"#).as_deref(), Some("dark"));
        assert_eq!(parse_theme_choice(r#"{"theme":"light"}"#).as_deref(), Some("light"));
        assert_eq!(parse_theme_choice(r#"{"theme":"system"}"#).as_deref(), Some("system"));
        assert_eq!(parse_theme_choice(r#"{"locale":"en"}"#), None);
        assert_eq!(parse_theme_choice("not-json"), None);
    }

    #[test]
    fn resolve_follows_pref_then_os() {
        assert!(!startup_is_dark(Some("light"), true));
        assert!(startup_is_dark(Some("dark"), false));
        assert!(startup_is_dark(Some("system"), true));
        assert!(!startup_is_dark(None, false));
    }
}
