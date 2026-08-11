import AppKit
import SwiftUI

/// 拿窗口句柄的探针视图（SwiftUI → AppKit 桥）：挂载后回调所在 NSWindow。
/// 用于安装标题栏双击缩放等壳层行为（不再挂原生后退/前进条）。
struct WindowAccessor: NSViewRepresentable {
    let onResolve: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            if let window = view.window { onResolve(window) }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        if let window = nsView.window { onResolve(window) }
    }
}
