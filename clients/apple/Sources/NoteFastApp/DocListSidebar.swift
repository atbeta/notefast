import SwiftUI
import NoteFast

/// 原生侧栏：范围过滤（笔记/收集箱/归档）+ 文档列表 + 底部导航。
/// 原生壳模式下 web 不再渲染自己的侧栏（见 web Layout.tsx native-shell 分支），
/// 收集箱/归档入口由此处承接。
enum DocScope: String, CaseIterable, Identifiable {
    case note = "note"
    case inbox = "inbox"
    case archived = "archived"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .note: return "笔记"
        case .inbox: return "收集箱"
        case .archived: return "归档"
        }
    }
}

struct DocListSidebar: View {
    @ObservedObject var model: AppModel
    @State private var docs: [DocSummary] = []
    @State private var loadError: String?
    /// 首次加载完成标记：空列表也要停 spinner（否则启动后空白时永远转圈）
    @State private var hasLoaded = false
    @State private var scope: DocScope = .note

    var body: some View {
        VStack(spacing: 0) {
            Picker("范围", selection: $scope) {
                ForEach(DocScope.allCases) { s in
                    Text(s.label).tag(s)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .onChange(of: scope) { _, _ in
                Task { await reload() }
            }

            List(docs, selection: $model.selectedDocID) { doc in
                DocRow(doc: doc)
                    .tag(doc.id)
            }
            .overlay {
                if !hasLoaded {
                    ProgressView()
                } else if let error = loadError, docs.isEmpty {
                    ContentUnavailableView(
                        "加载失败",
                        systemImage: "wifi.exclamationmark",
                        description: Text(error)
                    )
                } else if docs.isEmpty {
                    ContentUnavailableView(
                        scope == .note ? "暂无文档" : "列表为空",
                        systemImage: "doc.text",
                        description: scope == .note
                            ? Text("按 ⌘N 新建笔记")
                            : Text("文档会按状态归类到这里")
                    )
                }
            }

            Divider()
            HStack(spacing: 4) {
                Button {
                    if let url = model.pageURL("/graph") { model.navigator.navigate(to: url) }
                } label: {
                    Label("图谱", systemImage: "point.3.connected.trianglepath.dotted")
                        .font(.caption)
                        .frame(maxWidth: .infinity)
                }
                .help("知识图谱")
                Button {
                    model.openSettings()
                } label: {
                    Label("设置", systemImage: "gearshape")
                        .font(.caption)
                        .frame(maxWidth: .infinity)
                }
                .help("设置")
            }
            .buttonStyle(.plain)
            .padding(.vertical, 8)
            .padding(.horizontal, 6)
        }
        .navigationTitle("NoteFast")
        .task {
            await reload()
        }
        // 窗口重新激活时刷新（覆盖 ⌘N 新建、Web 内编辑等外部变更）
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await reload() }
        }
    }

    private func reload() async {
        loadError = nil
        guard let base = model.baseURL else { return }
        var path = "/docs/list"
        if scope != .note {
            path += "?status=\(scope.rawValue)"
        }
        do {
            let client = NoteFastClient(baseURL: base)
            docs = try await client.get(path, as: [DocSummary].self)
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        }
        hasLoaded = true
    }
}

private struct DocRow: View {
    let doc: DocSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(doc.title.isEmpty ? "（无标题）" : doc.title)
                .lineLimit(1)
            if !doc.tags.isEmpty {
                Text(doc.tags.prefix(3).joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 3)
    }
}
