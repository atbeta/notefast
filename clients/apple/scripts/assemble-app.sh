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

BUILD_ENGINE=1
SIGN_IDENTITY="-"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD_ENGINE=0; shift ;;
    --sign) SIGN_IDENTITY="${2:?--sign 需要身份}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

# 产物身份：DEV（ad-hoc）与发布（Developer ID）区分——
# 应用名/bundle ID/深链 scheme 全部隔离，两个版本可同时安装、应用列表可分辨
if [ "$SIGN_IDENTITY" = "-" ]; then
  APP_NAME="NoteFast Dev"
  EXEC_NAME="NoteFastDev"
  BUNDLE_ID="com.notefast.app.dev"
  URL_SCHEME="notefast-dev"
else
  APP_NAME="NoteFast"
  EXEC_NAME="NoteFast"
  BUNDLE_ID="com.notefast.app"
  URL_SCHEME="notefast"
fi
APP="$OUT_DIR/$APP_NAME.app"

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
cp "$APPLE_DIR/.build/release/NoteFastApp" "$APP/Contents/MacOS/$EXEC_NAME"
cp "$APPLE_DIR/Resources/AppIcon.icns" "$APP/Contents/Resources/"
# .md 文档图标（文件关联专用，区别于 App 图标；Info.plist 的 CFBundleTypeIconFile 引用）
cp "$APPLE_DIR/Resources/DocIcon.icns" "$APP/Contents/Resources/"
# engine 产物整体注入 Resources/engine（notefast-server + native/ + web-dist + VERSION）。
# 注意：必须排除 notefast-engine-*.tar.gz——tarball 内含构建时未签名的原始副本，
# 公证会扫描 bundle 内所有代码（含压缩包内），未签名副本会以「signature invalid /
# no secure timestamp / not hardened」整包拒绝。
find "$ENGINE_DIR" -maxdepth 1 -mindepth 1 -not -name '*.tar.gz' \
  -exec cp -R {} "$APP/Contents/Resources/engine/" \;

VERSION="$(cat "$ENGINE_DIR/VERSION")"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$EXEC_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>$BUNDLE_ID</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>$URL_SCHEME</string>
      </array>
    </dict>
  </array>
  <!-- 打开即导入：.md 关联（Alternate 不抢默认打开方式），双击/拖 Dock → 导入收集箱 -->
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Markdown 文档</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>CFBundleTypeIconFile</key><string>DocIcon</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>net.daringfireball.markdown</string>
        <string>public.markdown</string>
      </array>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>md</string>
        <string>markdown</string>
        <string>mdown</string>
        <string>mkd</string>
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
# 引擎二进制：Bun JIT entitlements（allow-jit + disable-library-validation；公证要求 --timestamp）
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
  --entitlements "$APPLE_DIR/Resources/notefast-server.entitlements" \
  "$APP/Contents/Resources/engine/notefast-server"
# 旁置 dylib（vec0 / libsqlite3）：与主进程同 Team 重签（公证要求 secure timestamp）
find "$APP/Contents/Resources/engine" -name '*.dylib' -print0 | while IFS= read -r -d '' dylib; do
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$dylib"
done
# app 主二进制 + bundle
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
  --entitlements "$APPLE_DIR/Resources/NoteFast.entitlements" \
  "$APP/Contents/MacOS/$EXEC_NAME"
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"

echo "==> [5/5] 校验"
codesign --verify --deep --strict "$APP"

echo ""
echo "✅ $APP"
echo "   版本 $VERSION · 运行: open \"$APP\""
