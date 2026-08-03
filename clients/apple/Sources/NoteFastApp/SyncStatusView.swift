import SwiftUI
import NoteFast

/// 工具栏同步状态按钮：点击弹出同步面板（状态 + 立即同步 + 首次恢复）。
struct SyncStatusButton: View {
    @ObservedObject var model: AppModel
    @State private var showPopover = false
    @State private var confirmPull = false

    var body: some View {
        Button {
            showPopover.toggle()
        } label: {
            SyncStatusIcon(status: model.syncStatus)
        }
        .help("多端同步状态")
        .popover(isPresented: $showPopover, arrowEdge: .bottom) {
            SyncStatusPanel(
                model: model,
                confirmPull: $confirmPull,
                onClose: { showPopover = false }
            )
            .padding(16)
            .frame(width: 320)
        }
    }
}

/// 同步状态图标：绿=最近成功同步；橙=上次失败；灰=未配置/未同步过
struct SyncStatusIcon: View {
    let status: SyncProtocolStatus?

    private var color: Color {
        guard let status else { return .gray }
        if status.lastError != nil { return .orange }
        if status.lastSuccessAt != nil { return .green }
        return .gray
    }

    var body: some View {
        Image(systemName: "arrow.triangle.2.circlepath")
            .foregroundStyle(color)
            .overlay(alignment: .topTrailing) {
                if let status, status.pendingChanges ?? 0 > 0 {
                    Circle()
                        .fill(.blue)
                        .frame(width: 7, height: 7)
                        .offset(x: 2, y: -2)
                }
            }
    }
}

private struct SyncStatusPanel: View {
    @ObservedObject var model: AppModel
    @Binding var confirmPull: Bool
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("多端同步")
                .font(.headline)

            if let status = model.syncStatus {
                VStack(alignment: .leading, spacing: 4) {
                    statusRow("状态", status.configured ? (status.enabled ? "已启用" : "已配置（未启用）") : "未配置")
                    if let bucket = status.s3Bucket {
                        statusRow("存储", bucket + (status.s3Prefix.map { " / \($0)" } ?? ""))
                    }
                    if let last = status.lastSuccessAt {
                        statusRow("上次成功", last)
                    }
                    if let error = status.lastError {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                    if let pending = status.pendingChanges, pending > 0 {
                        statusRow("待发布", "\(pending) 条变更")
                    }
                    if status.running == true {
                        Text("同步进行中…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 10) {
                    Button("立即同步") {
                        Task { await model.syncNow() }
                    }
                    .disabled(status.running == true)

                    Button("从云端恢复") {
                        confirmPull = true
                    }
                    .disabled(status.running == true)
                    .confirmationDialog(
                        "从云端恢复会覆盖本地数据（首次使用或数据丢失时使用），确定继续？",
                        isPresented: $confirmPull,
                        titleVisibility: .visible
                    ) {
                        Button("恢复", role: .destructive) {
                            Task { await model.syncPull() }
                        }
                        Button("取消", role: .cancel) {}
                    }
                }
            } else {
                Text("同步状态读取失败")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let message = model.syncActionMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func statusRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
