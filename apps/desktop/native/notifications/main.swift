import AppKit
import UserNotifications

// First-party local notifications. This app has no model, tasks, credentials,
// Shell execution, acknowledgement, or authorization to switch workspaces.
func taskResultURL(_ text: String) -> URL? {
    guard text.utf8.count <= 512,
          text.range(of: #"\Aserika://task-result/[A-Za-z0-9_-]{1,128}\?workspace=[a-f0-9]{64}\z"#,
                     options: .regularExpression) != nil else { return nil }
    return URL(string: text)
}

struct Command {
    var diagnose = false
    var validate = false
    var requestAuthorization = false
    var title = "Serika"
    var message: String?
    var group: String?
    var link: String?

    init(_ args: [String]) throws {
        var seen = Set<String>()
        var index = 0
        while index < args.count {
            let flag = args[index]
            guard seen.insert(flag).inserted else { throw ParseError.invalid }
            switch flag {
            case "-diagnose": diagnose = true
            case "-validate": validate = true
            case "-request-authorization": requestAuthorization = true
            case "-title", "-message", "-group", "-open":
                index += 1
                guard index < args.count, args[index].utf8.count <= 4096,
                      !args[index].contains("\0") else { throw ParseError.invalid }
                switch flag {
                case "-title": title = args[index]
                case "-message": message = args[index]
                case "-group": group = args[index]
                default: link = args[index]
                }
            default: throw ParseError.invalid
            }
            index += 1
        }
        if diagnose {
            guard seen.count == 1 else { throw ParseError.invalid }
        } else if !args.isEmpty {
            guard let message, !message.isEmpty, title.utf8.count <= 256 else { throw ParseError.invalid }
        }
        if let link {
            guard taskResultURL(link) != nil, group == link else { throw ParseError.invalid }
        }
        if let group { guard taskResultURL(group) != nil, group == link else { throw ParseError.invalid } }
        // Only the explicit in-app test may request permission. Workers cannot.
        if requestAuthorization { guard link == nil, group == nil else { throw ParseError.invalid } }
    }
    enum ParseError: Error { case invalid }
}

func finish(_ status: Int32, _ text: String) -> Never {
    if !text.isEmpty { print(text); fflush(stdout) }
    exit(status)
}

let command: Command
do { command = try Command(Array(CommandLine.arguments.dropFirst())) }
catch { finish(2, "Invalid Serika notification arguments") }
// Pure validation is available for regression tests; never invokes NotificationCenter.
if command.validate { finish(0, "valid") }

final class NotificationDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if command.diagnose {
            center.getNotificationSettings { settings in
                let name: String
                switch settings.authorizationStatus {
                case .notDetermined: name = "not requested yet"
                case .denied: name = "denied"
                case .authorized, .provisional: name = "authorized"
                default: name = "unknown"
                }
                finish(name == "authorized" ? 0 : 3, "Serika notifications\n  authorization       \(name)")
            }
        } else if command.message != nil {
            if command.requestAuthorization {
                // The OS displays consent. This program never answers for the user.
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    guard error == nil, granted else { finish(3, "Notification permission not granted") }
                    self.submit()
                }
            } else {
                center.getNotificationSettings { settings in
                    guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
                    else { finish(3, "Notification permission not granted; use Serika's explicit test button") }
                    self.submit()
                }
            }
        }
        // Cold launches from a notification click have no command line. Stay
        // alive briefly for the OS response callback, without showing a window.
        DispatchQueue.main.asyncAfter(deadline: .now() + (command.requestAuthorization ? 120 : 15)) {
            finish(4, "Notification operation not confirmed")
        }
    }
    func submit() {
        let content = UNMutableNotificationContent()
        content.title = command.title
        content.body = command.message!
        content.sound = .default
        if let link = command.link { content.userInfo = ["taskResultURL": link] }
        let request = UNNotificationRequest(identifier: command.group ?? UUID().uuidString,
                                            content: content, trigger: nil)
        center.add(request) { error in
            guard error == nil else { finish(1, "Notification submission failed") }
            // Accepted by the OS is not visible delivery or acknowledgement.
            finish(0, "submitted")
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let text = response.notification.request.content.userInfo["taskResultURL"] as? String,
              let url = taskResultURL(text) else {
            completionHandler()
            DispatchQueue.main.async { finish(0, "") }
            return
        }
        // Only navigation to the existing read-only handler. The desktop must
        // still validate workspace ownership and read the exact stored task.
        DispatchQueue.main.async {
            let opened = NSWorkspace.shared.open(url)
            completionHandler()
            finish(opened ? 0 : 1, opened ? "opened" : "Navigation unavailable")
        }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = NotificationDelegate()
application.delegate = delegate
application.run()
