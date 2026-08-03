// NoteFast 应用图标生成器（可复现；产物提交为 Resources/AppIcon.icns）
// 用法：swift gen-icon.swift <output-1024.png>
// 风格：macOS Sonoma 级质感 —— 大圆角 squircle + 三阶蓝色渐变 + 顶部玻璃高光
//       + 三条白色圆头横线（favicon 递减宽度）带投影。概念保持「三条线」品牌。
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
let bgPath = CGPath(roundedRect: CGRect(x: 0, y: 0, width: 1024, height: 1024),
                    cornerWidth: corner, cornerHeight: corner, transform: nil)
ctx.addPath(bgPath)
ctx.clip()

// 三阶垂直渐变（上亮下深，制造体积感）
let stops: [CGFloat] = [0, 0.45, 1]
let colors = [
    CGColor(red: 0.47, green: 0.72, blue: 1.00, alpha: 1),   // #78B8FF
    CGColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1),   // #3B82F6
    CGColor(red: 0.11, green: 0.29, blue: 0.85, alpha: 1),   // #1C4AE0
] as CFArray
let gradient = CGGradient(colorsSpace: space, colors: colors, locations: stops)!
ctx.drawLinearGradient(gradient,
                       start: CGPoint(x: 0, y: 1024), end: CGPoint(x: 0, y: 0),
                       options: [])

// ── 顶部玻璃高光（上半部白色渐隐，clip 已在上）──
let glossColors = [
    CGColor(red: 1, green: 1, blue: 1, alpha: 0.42),
    CGColor(red: 1, green: 1, blue: 1, alpha: 0.10),
    CGColor(red: 1, green: 1, blue: 1, alpha: 0.0),
] as CFArray
let gloss = CGGradient(colorsSpace: space, colors: glossColors, locations: [0, 0.45, 0.7])!
ctx.drawLinearGradient(gloss,
                       start: CGPoint(x: 0, y: 1024), end: CGPoint(x: 0, y: 280),
                       options: [])

// ── 三条白色圆头横线（favicon 比例：50% / 37.5% / 31% 递减；带投影）──
ctx.setShadow(
    offset: CGSize(width: 0, height: -22),
    blur: 40,
    color: CGColor(red: 0.03, green: 0.10, blue: 0.35, alpha: 0.35)
)
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
let barHeight: CGFloat = 74
let bars: [(width: CGFloat, yCenter: CGFloat)] = [
    (512, 668),
    (384, 512),
    (320, 356),
]
for bar in bars {
    let rect = CGRect(x: (1024 - bar.width) / 2, y: bar.yCenter - barHeight / 2,
                      width: bar.width, height: barHeight)
    ctx.addPath(CGPath(roundedRect: rect,
                       cornerWidth: barHeight / 2, cornerHeight: barHeight / 2,
                       transform: nil))
    ctx.fillPath()
}
ctx.setShadow(offset: .zero, blur: 0, color: nil)

guard let image = ctx.makeImage() else { fatalError("位图生成失败") }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
guard let dest = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("目标创建失败: \(output.path)")
}
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("icon → \(output.path)")
