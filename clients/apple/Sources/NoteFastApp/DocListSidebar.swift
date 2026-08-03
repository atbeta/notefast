import SwiftUI
import NoteFast

/// 侧栏文档列表（原生列表 + 原生选中态，点击驱动 WebView 内容区跳转）。
struct DocListSidebar: View {
    @ObservedObject var model: AppModel
    @State private var docs: [DocSummary] = []
    @State private var loadError: String?

    var body: some View {
        List(docs, selection: $model.selectedDocID) { doc in
            DocRow(doc: doc)
                .tag(doc.id)
        }
        .navigationTitle("NoteFast")
        .overlay {
            if docs.isEmpty && loadError == nil {
                ProgressView()
            } else if let error = loadError {
                ContentUnavailableView(
                    "加载失败",
                    systemImage: "wifi.exclamationmark",
                    description: Text(error)
                )
            }
        }
        .task {
            await reload()
        }
    }

    private func reload() async {
        loadError = nil
        guard let base = model.baseURL else { return }
        do {
            let client = NoteFastClient(baseURL: base)
            docs = try await client.get("/docs/list", as: [DocSummary].self)
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        }
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
