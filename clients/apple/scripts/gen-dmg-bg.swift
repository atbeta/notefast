// NoteFast DMG 窗口背景图生成器（可复现）
// 用法：swift gen-dmg-bg.swift <output.png>
// 规格：660x440（与 make-dmg.sh 的 Finder 窗口 bounds 对应）
// 风格：品牌蓝柔和渐变 + 左上角 NoteFast 字标
import AppKit

let width: CGFloat = 660
let height: CGFloat = 440
let size = NSSize(width: width, height: height)

let image = NSImage(size: size)
image.lockFocus()

// 垂直渐变（上浅下略深，品牌蓝调）
let top = NSColor(calibratedRed: 0.965, green: 0.976, blue: 0.992, alpha: 1)   // #F6F9FD
let bottom = NSColor(calibratedRed: 0.902, green: 0.933, blue: 0.973, alpha: 1) // #E6EEF8
let gradient = NSGradient(colors: [top, bottom])!
gradient.draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: -90)

// 左上角字标（半透明品牌蓝，避免与图标抢视觉）
let wordmark = "NoteFast" as NSString
let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 26, weight: .semibold),
    .foregroundColor: NSColor(calibratedRed: 0.15, green: 0.39, blue: 0.92, alpha: 0.55),
]
wordmark.draw(at: NSPoint(x: 24, y: height - 58), withAttributes: attrs)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    fatalError("PNG 编码失败")
}
let output = URL(fileURLWithPath: CommandLine.arguments[1])
try! png.write(to: output)
print("dmg background → \(output.path)")
