import AppKit
import Combine
import SwiftUI

/// 左上角原生导航条（红绿灯右侧）：后退 / 前进按钮。
///
/// 背景：macOS 壳隐藏式标题栏的 30px 净空带（--shell-top-inset）由侧栏延伸背景填充，
/// 但红绿灯右侧什么都没有，视觉上是一大片空白。这里放上 web 界面里本来就没有的
/// 浏览器式后退/前进——不重复 web 已有 UI，是纯壳层增量。
///
/// 设计要点：
/// - hitTest 只命中两个按钮，其余区域全部透传给下方 web 拖拽区（侧栏延伸带本身可拖窗）
/// - 颜色跟随 web 主题（applyWebTheme 设 appearance），而非系统外观——
///   web 深色 + 系统浅色时按钮不能隐形
/// - 窗口宽度 < md 断点（768px）时 web 切移动顶栏（汉堡按钮在左上），整条隐藏防重叠
@MainActor
final class NavStripView: NSView {
    private let backButton: NSButton
    private let forwardButton: NSButton
    private var cancellables = Set<AnyCancellable>()

    init(model: AppModel) {
        backButton = Self.makeButton(symbol: "chevron.left", accessibilityLabel: "后退")
        forwardButton = Self.makeButton(symbol: "chevron.right", accessibilityLabel: "前进")
        super.init(frame: .zero)

        backButton.target = self
        backButton.action = #selector(goBack)
        forwardButton.target = self
        forwardButton.action = #selector(goForward)
        backButton.isEnabled = false
        forwardButton.isEnabled = false

        addSubview(backButton)
        addSubview(forwardButton)
        NSLayoutConstraint.activate([
            backButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 80),
            backButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            backButton.widthAnchor.constraint(equalToConstant: 24),
            backButton.heightAnchor.constraint(equalToConstant: 22),
            forwardButton.leadingAnchor.constraint(equalTo: backButton.trailingAnchor, constant: 2),
            forwardButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            forwardButton.widthAnchor.constraint(equalToConstant: 24),
            forwardButton.heightAnchor.constraint(equalToConstant: 22),
        ])

        model.$canGoBack
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.backButton.isEnabled = $0 }
            .store(in: &cancellables)
        model.$canGoForward
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.forwardButton.isEnabled = $0 }
            .store(in: &cancellables)
        self.model = model
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) 未实现") }

    private weak var model: AppModel?

    private static func makeButton(symbol: String, accessibilityLabel: String) -> NSButton {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: accessibilityLabel)
        let button = NSButton(image: image!, target: nil, action: nil)
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleProportionallyDown
        button.contentTintColor = .secondaryLabelColor
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setAccessibilityLabel(accessibilityLabel)
        return button
    }

    /// 只让按钮可点，条带其余区域透传到 web 拖拽区（单击拖窗行为不变）
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return (hit === backButton || hit === forwardButton) ? hit : nil
    }

    /// web 主题经消息桥回报后调用（data-theme = light|dark）
    func applyWebTheme(dark: Bool) {
        appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    }

    @objc private func goBack() { model?.navigator.goBack() }
    @objc private func goForward() { model?.navigator.goForward() }
}

/// 拿窗口句柄的探针视图（SwiftUI → AppKit 桥）：挂载后回调所在 NSWindow
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
