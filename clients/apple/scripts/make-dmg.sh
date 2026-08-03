#!/usr/bin/env bash
set -euo pipefail

# 组装拖拽安装式 DMG（Applications 快捷方式 + NoteFast.app + 卷图标 + 窗口布局）。
# 用法：./make-dmg.sh <NoteFast.app路径> <输出.dmg路径>
# 注意：DMG 内的 .app 应已公证 + 钉章；DMG 本身也要再公证（Gatekeeper 检查最外层容器）。
#
# 流程：staging（app + 快捷方式 + 卷图标 + 背景图）→ 临时 UDRW → Finder 脚本设窗口布局
#       → detach → 压缩 UDZO。Finder 布局失败不阻断（CI 无 GUI 会话时降级为默认布局）。

APP="${1:?用法: make-dmg.sh <app路径> <dmg路径>}"
OUT="${2:?用法: make-dmg.sh <app路径> <dmg路径>}"
VOLNAME="NoteFast"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 卷图标复用应用图标（.VolumeIcon.icns），Finder 显示 NoteFast 而非通用磁盘
ICON="$SCRIPT_DIR/../Resources/AppIcon.icns"

WIN_W=660
WIN_H=440
ICON_SIZE=110
APP_X=150
APP_Y=215
APPS_X=500
APPS_Y=215

STAGE="$(mktemp -d)"
TMP_DMG="$(mktemp -u /tmp/notefast-dmg-XXXXXX).dmg"
trap 'rm -rf "$STAGE"; [ -e "$TMP_DMG" ] && rm -f "$TMP_DMG"' EXIT

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
if [ -f "$ICON" ]; then
  cp "$ICON" "$STAGE/.VolumeIcon.icns"
  SetFile -a C "$STAGE" || true
fi

# 窗口背景图（.background/ 必须存在于卷内，Finder 存的是卷内引用）
mkdir -p "$STAGE/.background"
swift "$SCRIPT_DIR/gen-dmg-bg.swift" "$STAGE/.background/background.png" >/dev/null

# 临时可写 DMG → 设置布局 → 压缩
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDRW "$TMP_DMG" >/dev/null
MOUNT="$(hdiutil attach -nobrowse -noautoopen "$TMP_DMG" | awk -F'\t' 'END { print $NF }')"
trap 'rm -rf "$STAGE"; hdiutil detach "$MOUNT" >/dev/null 2>&1 || true; [ -e "$TMP_DMG" ] && rm -f "$TMP_DMG"' EXIT

# 注意：不能用 `tell window 1` 嵌套块访问视图选项——macOS 26 下 `icon view options`
# 在嵌套块内解析错对象（-10006），必须用显式 `icon view options of window 1`
osascript - "$MOUNT" <<OSA >/dev/null 2>&1 || echo "⚠️  Finder 布局设置失败（无 GUI 会话时属预期），DMG 仍可用"
on run argv
  set volPath to item 1 of argv
  tell application "Finder"
    set dmgFolder to (POSIX file volPath) as alias
    open dmgFolder
    delay 1.5
    set current view of window 1 to icon view
    set toolbar visible of window 1 to false
    set statusbar visible of window 1 to false
    set bounds of window 1 to {0, 0, $WIN_W, $WIN_H}
    delay 1
    set icon size of icon view options of window 1 to $ICON_SIZE
    set arrangement of icon view options of window 1 to not arranged
    set background picture of icon view options of window 1 to POSIX file (volPath & "/.background/background.png")
    delay 0.5
    set position of item "NoteFast.app" of window 1 to {$APP_X, $APP_Y}
    set position of item "Applications" of window 1 to {$APPS_X, $APPS_Y}
    delay 0.5
    close window 1
  end tell
end run
OSA

hdiutil detach "$MOUNT" >/dev/null || { sleep 2; hdiutil detach -force "$MOUNT" >/dev/null 2>&1 || true; }
trap 'rm -rf "$STAGE"; [ -e "$TMP_DMG" ] && rm -f "$TMP_DMG"' EXIT

hdiutil convert "$TMP_DMG" -format UDZO -o "$OUT" >/dev/null
echo "dmg → $OUT"
