// NoteFast 应用图标生成器（可复现；产物提交为 Resources/AppIcon.icns）
// 用法：swift gen-icon.swift <output-1024.png>
// 风格：macOS 大圆角 + 蓝色垂直渐变 + 三条白色圆头横线（对齐 web favicon）
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

// 背景：大圆角矩形（macOS 图标风格，圆角 ≈ 半径 22%）
let corner: CGFloat = 228
let bgPath = CGPath(roundedRect: CGRect(x: 0, y: 0, width: 1024, height: 1024),
                    cornerWidth: corner, cornerHeight: corner, transform: nil)
ctx.addPath(bgPath)
ctx.clip()

// 垂直渐变：#4f9ef8（上）→ #2563eb（下）
let colors = [
    CGColor(red: 0.31, green: 0.62, blue: 0.97, alpha: 1),   // #4f9ef8
    CGColor(red: 0.15, green: 0.39, blue: 0.92, alpha: 1),   // #2563eb
] as CFArray
let gradient = CGGradient(colorsSpace: space, colors: colors, locations: [0, 1])!
ctx.drawLinearGradient(gradient,
                       start: CGPoint(x: 0, y: 1024), end: CGPoint(x: 0, y: 0),
                       options: [])

// 三条白色圆头横线（CG 坐标原点在左下，y 对称排布）
let barWidth: CGFloat = 512
let barHeight: CGFloat = 72
let barX = (1024 - barWidth) / 2
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
for yCenter in [340.0, 512.0, 684.0] {
    let bar = CGRect(x: barX, y: yCenter - barHeight / 2, width: barWidth, height: barHeight)
    ctx.addPath(CGPath(roundedRect: bar, cornerWidth: barHeight / 2, cornerHeight: barHeight / 2, transform: nil))
    ctx.fillPath()
}

guard let image = ctx.makeImage() else { fatalError("位图生成失败") }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
guard let dest = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("目标创建失败: \(output.path)")
}
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("icon → \(output.path)")
