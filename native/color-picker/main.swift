import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var sampler: NSColorSampler?

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)

            self.sampler = NSColorSampler()
            self.sampler?.show { selectedColor in
                defer {
                    self.sampler = nil
                    NSApplication.shared.terminate(nil)
                }

                guard let color = selectedColor?.usingColorSpace(.sRGB) else {
                    FileHandle.standardOutput.write("null".data(using: .utf8)!)
                    return
                }

                let payload: [String: Any] = [
                    "red": color.redComponent,
                    "green": color.greenComponent,
                    "blue": color.blueComponent,
                    "alpha": color.alphaComponent,
                    "colorSpace": "srgb",
                ]

                if let data = try? JSONSerialization.data(withJSONObject: payload) {
                    FileHandle.standardOutput.write(data)
                } else {
                    FileHandle.standardOutput.write("null".data(using: .utf8)!)
                }
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
