import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            switch model.state {
            case .starting:
                VStack(spacing: 14) {
                    ProgressView()
                    Text("正在启动本地 NoteFast…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(minWidth: 560, minHeight: 420)
            case .running(let handshake):
                MainView(model: model, handshake: handshake)
            case .failed(let error):
                FailureView(error: error) {
                    model.restart()
                }
                .frame(minWidth: 560, minHeight: 420)
            }
        }
        .task {
            await model.start()
        }
        .onAppear {
            // openWindow 只能在视图侧取，注入 AppModel 供菜单栏/Dock/深链重建主窗口
            model.openWindowAction = { openWindow(id: "main") }
        }
    }
}

private struct FailureView: View {
    let error: Error
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 34))
                .foregroundStyle(.orange)
            Text("NoteFast 启动失败")
                .font(.title3.weight(.semibold))
            Text(error.localizedDescription)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button("重试", action: onRetry)
                .keyboardShortcut(.defaultAction)
        }
        .padding(32)
    }
}
