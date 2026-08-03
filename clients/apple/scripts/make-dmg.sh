#!/usr/bin/env bash
set -euo pipefail

# 组装拖拽安装式 DMG（Applications 快捷方式 + NoteFast.app）。
# 用法：./make-dmg.sh <NoteFast.app路径> <输出.dmg路径>
# 注意：DMG 内的 .app 应已公证 + 钉章；DMG 本身也要再公证（Gatekeeper 检查最外层容器）。

APP="${1:?用法: make-dmg.sh <app路径> <dmg路径>}"
OUT="${2:?用法: make-dmg.sh <app路径> <dmg路径>}"
VOLNAME="NoteFast"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "$VOLNAME" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$OUT"

echo "dmg → $OUT"
