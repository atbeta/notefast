#!/usr/bin/env bash
set -euo pipefail

# 组装 NoteFast.app：
#   1. bun run build:engine（packages/server/dist-engine/）
#   2. swift build -c release（clients/apple）
#   3. 组装 bundle（Contents/MacOS + Contents/Resources/engine + Info.plist + PkgInfo）
#   4. 签名（engine 带 Bun JIT entitlements；app 主二进制 + bundle）
#   5. codesign --verify
#
# 用法：./scripts/assemble-app.sh [--no-build] [--sign <identity>]
#   --no-build       跳过 bun run build:engine（已构建时用，仅重打包 Swift 壳）
#   --sign <identity>签名身份（缺省 "-" = ad-hoc 本地开发；发布用 "Developer ID Application: <名字>"，
#                    配合 scripts/notarize.sh 走公证）

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APPLE_DIR="$ROOT/clients/apple"
ENGINE_DIR="$ROOT/packages/server/dist-engine"
OUT_DIR="$APPLE_DIR/dist"
APP_NAME="NoteFast"
APP="$OUT_DIR/$APP_NAME.app"

BUILD_ENGINE=1
SIGN_IDENTITY="-"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD_ENGINE=0; shift ;;
    --sign) SIGN_IDENTITY="${2:?--sign 需要身份}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

echo "==> [1/5] engine 产物"
if [ "$BUILD_ENGINE" = "1" ]; then
  (cd "$ROOT" && bun run build:engine)
fi
[ -x "$ENGINE_DIR/notefast-server" ] || { echo "缺少 $ENGINE_DIR/notefast-server，请先 bun run build:engine" >&2; exit 1; }
[ -f "$ENGINE_DIR/VERSION" ] || { echo "engine 缺 VERSION" >&2; exit 1; }

echo "==> [2/5] swift build（release）"
(cd "$APPLE_DIR" && swift build -c release --product NoteFastApp)

echo "==> [3/5] 组装 .app bundle"
rm -rf "$OUT_DIR"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine"
cp "$APPLE_DIR/.build/release/NoteFastApp" "$APP/Contents/MacOS/$APP_NAME"
# engine 产物整体注入 Resources/engine（notefast-server + native/ + web-dist + VERSION）
cp -R "$ENGINE_DIR/." "$APP/Contents/Resources/engine/"

VERSION="$(cat "$ENGINE_DIR/VERSION")"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.notefast.app</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.notefast.app</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>notefast</string>
      </array>
    </dict>
  </array>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

# 注意：全角字符不能紧贴 $var（UTF-8 locale 下 bash 会把多字节首字节吞进变量名），用 ${} 包裹
echo "==> [4/5] 签名（身份: ${SIGN_IDENTITY}）"
# 引擎二进制：Bun JIT entitlements（allow-jit 等）
codesign --force --options runtime --sign "$SIGN_IDENTITY" \
  --entitlements "$APPLE_DIR/Resources/notefast-server.entitlements" \
  "$APP/Contents/Resources/engine/notefast-server"
# 旁置 dylib（vec0 / libsqlite3）：ad-hoc 签名，避免 hardened runtime 校验告警
find "$APP/Contents/Resources/engine" -name '*.dylib' -print0 | while IFS= read -r -d '' dylib; do
  codesign --force --sign "$SIGN_IDENTITY" "$dylib"
done
# app 主二进制 + bundle
codesign --force --options runtime --sign "$SIGN_IDENTITY" \
  --entitlements "$APPLE_DIR/Resources/NoteFast.entitlements" \
  "$APP/Contents/MacOS/$APP_NAME"
codesign --force --options runtime --sign "$SIGN_IDENTITY" "$APP"

echo "==> [5/5] 校验"
codesign --verify --deep --strict "$APP"

echo ""
echo "✅ $APP"
echo "   版本 $VERSION · 运行: open \"$APP\""
