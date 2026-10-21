import SwiftUI
import UserNotifications

/// Fenêtre Réglages (⌘,) : garde-fous et notifications.
struct SettingsView: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        @Bindable var store = store
        TabView(selection: $store.settingsTab) {
            Tab("Garde-fous", systemImage: Icon.guardRule, value: SettingsTab.guards) {
                GuardSettingsView()
            }
            Tab("Notifications", systemImage: "bell", value: SettingsTab.notifications) {
                NotificationSettingsView()
            }
        }
        .frame(width: 520)
        .frame(minHeight: 420)
    }
}

/// Garde-fous : activés, où décider des actions sensibles, règles.
struct GuardSettingsView: View {
    @Environment(VigieStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Form {
            Section {
                Toggle("Garde-fous activés", isOn: $store.guardEnabled)
                Text("Une action sensible s'affiche dans ta conversation (la fenêtre habituelle de Claude Code) et dans Vigie : "
                     + "réponds où tu veux, l'autre se ferme. Avec Codex, c'est dans Vigie.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Picker("Refusée automatiquement après", selection: $store.guardWaitMin) {
                    ForEach(waitChoices, id: \.self) { minutes in
                        Text(minutes == 0 ? "tout de suite" : "\(minutes) min").tag(minutes)
                    }
                }
                .disabled(!store.guardEnabled)
            }
            if let rules = store.settings?.guardRules?.rules, !rules.isEmpty {
                Section("Règles") {
                    ForEach(rules) { rule in
                        Toggle(rule.label ?? rule.id, isOn: Binding(
                            get: { rule.disabled != true },
                            set: { store.setGuardRule(rule.id, active: $0) }
                        ))
                    }
                }
                .disabled(!store.guardEnabled)
            }
        }
        .pageForm()
    }

    private var waitChoices: [Int] {
        let base = [0, 2, 5, 10, 20, 30]
        return base.contains(store.guardWaitMin) ? base : (base + [store.guardWaitMin]).sorted()
    }
}

/// Notifications : un interrupteur par type, et l'état de l'autorisation du Mac.
struct NotificationSettingsView: View {
    @State private var status: UNAuthorizationStatus?

    var body: some View {
        Form {
            if status == .denied {
                Section {
                    HStack {
                        Label("Notifications refusées pour Vigie", systemImage: "bell.slash")
                            .foregroundStyle(.red)
                        Spacer()
                        Button("Ouvrir Réglages Système") {
                            SystemActions.open("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
                        }
                    }
                }
            }
            Section {
                ForEach(NotifyKind.allCases) { kind in
                    NotifyToggle(kind: kind)
                }
            } header: {
                Text("Me prévenir quand")
            } footer: {
                Text("Une seule notification par élément. Un clic l'ouvre dans Vigie.")
                    .foregroundStyle(.secondary)
            }
        }
        .pageForm()
        .task { status = await Self.authorization() }
    }

    private static func authorization() async -> UNAuthorizationStatus? {
        guard Bundle.main.bundlePath.hasSuffix(".app") else { return nil }
        return await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }
}

private struct NotifyToggle: View {
    let kind: NotifyKind
    @AppStorage private var on: Bool

    init(kind: NotifyKind) {
        self.kind = kind
        _on = AppStorage(wrappedValue: true, kind.defaultsKey)
    }

    var body: some View {
        Toggle(isOn: $on) {
            Label(kind.title, systemImage: kind.symbol)
        }
    }
}
