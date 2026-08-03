#!/usr/bin/env bash
set -euo pipefail

# 公证 NoteFast.app（Developer ID 分发，见 .ai/macos-native-client.md §10）：
#   1. 组装：assemble-app.sh --sign "Developer ID Application: <Team>"
#   2. zip 打包
#   3. xcrun notarytool submit（凭据走钥匙串 profile，见下方说明）
#   4. stapler 钉章
#
# 用法：
#   1. 一次性（钥匙串）：
#      xcrun notarytool store-credentials "notefast" --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-password>
#   2. 运行：
#      ./scripts/notarize.sh --sign "Developer ID Application: <名字>" [--profile notefast]
#
# 注意：Bun JIT entitlements（allow-jit）意味着不能上 Mac App Store，走 Developer ID + 公证

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APPLE_DIR="$ROOT/clients/apple"
APP="$APPLE_DIR/dist/NoteFast.app"

SIGN_IDENTITY="-"
PROFILE="notefast"
while [ $# -gt 0 ]; do
  case "$1" in
    --sign) SIGN_IDENTITY="${2:?--sign 需要身份}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile 需要名字}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

[ "$SIGN_IDENTITY" != "-" ] || { echo "公证必须用 Developer ID 身份（--sign）" >&2; exit 1; }

echo "==> [1/3] 组装（Developer ID 签名）"
(cd "$APPLE_DIR" && ./scripts/assemble-app.sh --sign "$SIGN_IDENTITY")

echo "==> [2/3] zip 打包 + notarytool submit"
(cd "$APPLE_DIR/dist" && ditto -c -k --keepParent NoteFast.app NoteFast.zip)
xcrun notarytool submit "$APPLE_DIR/dist/NoteFast.zip" --keychain-profile "$PROFILE" --wait

echo "==> [3/3] 钉章"
xcrun stapler staple "$APP"
spctl --assess --type execute --verbose=4 "$APP"

echo ""
echo "✅ 公证完成: $APP"
