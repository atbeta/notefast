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
                if model.versionIncompatible && !model.dismissedVersionWarning {
                    VersionIncompatibleView(
                        engineVersion: model.engineVersion ?? "未知",
                        minVersion: AppModel.minSupportedEngineVersion,
                        onDownload: { model.openUpdateDownload() },
                        onContinueAnyway: { model.dismissedVersionWarning = true }
                    )
                    .frame(minWidth: 560, minHeight: 420)
                } else {
                    MainView(model: model, handshake: handshake)
                }
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

/// 引擎版本低于客户端最低支持：阻断式提示（契约只加不改，旧引擎配新客户端有静默坏掉的风险）。
/// 「仍要继续」留给知道自己在干什么的用户。
private struct VersionIncompatibleView: View {
    let engineVersion: String
    let minVersion: String
    let onDownload: () -> Void
    let onContinueAnyway: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 34))
                .foregroundStyle(.orange)
            Text("客户端版本需要更新")
                .font(.title3.weight(.semibold))
            Text("内嵌引擎版本 v\(engineVersion)，低于此客户端要求的最低版本 v\(minVersion)。继续使用可能遇到功能异常，请下载最新版本。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            HStack(spacing: 12) {
                Button("下载最新版", action: onDownload)
                    .keyboardShortcut(.defaultAction)
                Button("仍要继续", action: onContinueAnyway)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(32)
    }
}
