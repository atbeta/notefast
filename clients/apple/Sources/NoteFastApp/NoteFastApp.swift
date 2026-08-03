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
        .commands {
            AppMenuCommands(model: model)
        }
    }
}
