// NoteFast 应用图标生成器（可复现；产物提交为 Resources/AppIcon.icns）
// 用法：swift gen-icon.swift <output-1024.png>
// 构图对齐 web favicon.svg：纯色蓝底 + 左对齐递减三线（扁平，无渐变/投影）。
// 外轮廓用 macOS squircle 裁切（系统会再套模板；源图自带圆角便于预览与 DMG）。
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let space = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
    data: nil, width: size, height: size,
    bitsPerComponent: 8, bytesPerRow: 0, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("CGContext 创建失败") }

// ── 背景：大圆角 squircle（圆角 ≈ 半径 22%，接近 Apple 图标比例）──
let corner: CGFloat = 228
let bgPath = CGPath(
    roundedRect: CGRect(x: 0, y: 0, width: 1024, height: 1024),
    cornerWidth: corner, cornerHeight: corner, transform: nil
)
ctx.addPath(bgPath)
ctx.clip()

// 纯色蓝（与 favicon #3b82f6 一致）
ctx.setFillColor(CGColor(red: 0.231, green: 0.510, blue: 0.965, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))

// ── 左对齐三线（favicon 32 坐标系 ×32：x=8，宽 16/12/10，y=10/16/22，线粗 2.5）──
// CG 原点在左下，故 SVG y 翻转为 1024 - y*32。
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
let barHeight: CGFloat = 80 // 2.5 × 32
let left: CGFloat = 256     // 8 × 32
let bars: [(width: CGFloat, yCenter: CGFloat)] = [
    (512, 1024 - 320), // top  y=10 → 320 from top
    (384, 1024 - 512), // mid  y=16
    (320, 1024 - 704), // bot  y=22
]
for bar in bars {
    let rect = CGRect(
        x: left,
        y: bar.yCenter - barHeight / 2,
        width: bar.width,
        height: barHeight
    )
    ctx.addPath(CGPath(
        roundedRect: rect,
        cornerWidth: barHeight / 2,
        cornerHeight: barHeight / 2,
        transform: nil
    ))
    ctx.fillPath()
}

guard let image = ctx.makeImage() else { fatalError("位图生成失败") }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
guard let dest = CGImageDestinationCreateWithURL(
    output as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
) else {
    fatalError("目标创建失败: \(output.path)")
}
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("icon → \(output.path)")
