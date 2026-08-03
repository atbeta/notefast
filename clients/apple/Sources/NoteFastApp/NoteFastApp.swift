import SwiftUI

@main
struct NoteFastApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .onOpenURL { url in
                    model.handle(url: url)
                }
        }
        .defaultSize(width: 1100, height: 720)
        .commands {
            AppMenuCommands(model: model)
        }
    }
}
