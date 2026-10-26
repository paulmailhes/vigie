import AppKit
import SwiftUI

/// Long texte (questionnaire, e-mail du client, adresses) : bordé, avec son exemple en gris tant qu'il est vide.
/// `onFiles` : les fichiers glissés dedans sont joints, au lieu d'écrire leur chemin dans le texte ; le bord se colore
/// pendant le survol.
struct AgentTextArea: View {
    @Binding var text: String
    var placeholder: String?
    var label: String
    var minHeight: CGFloat = 140
    var onFiles: ((NSPasteboard) -> Void)?
    @State private var targeted = false

    var body: some View {
        FileDropTextEditor(text: $text, label: label, onFiles: onFiles, targeted: $targeted)
            .background(.quinary, in: .rect(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(targeted ? AnyShapeStyle(Theme.action) : AnyShapeStyle(.separator), lineWidth: targeted ? 2 : 1)
            }
            .overlay(alignment: .topLeading) {
                if text.isEmpty, let placeholder {
                    Text(placeholder)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 9)
                        .allowsHitTesting(false)
                }
            }
            .frame(minHeight: minHeight)
    }
}

/// Le texte lui-même, en AppKit : le champ de texte de SwiftUI prend les fichiers glissés avant tout le monde et y
/// écrit leur chemin. Celui-ci les reconnaît d'abord (Finder, Mail, Safari) ; un texte glissé s'écrit comme d'habitude.
private struct FileDropTextEditor: NSViewRepresentable {
    @Binding var text: String
    var label: String
    var onFiles: ((NSPasteboard) -> Void)?
    @Binding var targeted: Bool

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = FileDropTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.autohidesScrollers = true
        if let textView = scroll.documentView as? FileDropTextView {
            textView.isRichText = false
            textView.importsGraphics = false
            textView.allowsUndo = true
            textView.drawsBackground = false
            textView.font = .systemFont(ofSize: NSFont.systemFontSize)
            textView.textColor = .labelColor
            textView.textContainerInset = NSSize(width: 8, height: 9)
            textView.string = text
            textView.delegate = context.coordinator
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.text = $text
        guard let textView = scroll.documentView as? FileDropTextView else { return }
        if textView.string != text { textView.string = text }
        textView.setAccessibilityLabel(label)
        let targeted = $targeted
        textView.onTargeted = { targeted.wrappedValue = $0 }
        if (textView.onFiles == nil) != (onFiles == nil) {
            textView.onFiles = onFiles
            textView.updateDragTypeRegistration()
        } else {
            textView.onFiles = onFiles
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            text.wrappedValue = textView.string
        }
    }
}

/// Le champ de texte qui reconnaît les fichiers glissés : il les passe à `onFiles` et n'écrit rien.
private final class FileDropTextView: NSTextView {
    var onFiles: ((NSPasteboard) -> Void)?
    var onTargeted: ((Bool) -> Void)?

    override var acceptableDragTypes: [NSPasteboard.PasteboardType] {
        var types = super.acceptableDragTypes
        guard onFiles != nil else { return types }
        for type in AgentDropBox.dragTypes where !types.contains(type) { types.append(type) }
        return types
    }

    private func carriesFiles(_ sender: any NSDraggingInfo) -> Bool {
        onFiles != nil && AgentDropBox.carriesFiles(sender.draggingPasteboard)
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard carriesFiles(sender) else { return super.draggingEntered(sender) }
        onTargeted?(true)
        return .copy
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard carriesFiles(sender) else { return super.draggingUpdated(sender) }
        return .copy
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) {
        onTargeted?(false)
        super.draggingExited(sender)
    }

    override func prepareForDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        carriesFiles(sender) || super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        guard carriesFiles(sender), let onFiles else { return super.performDragOperation(sender) }
        onTargeted?(false)
        onFiles(sender.draggingPasteboard)
        return true
    }

    override func concludeDragOperation(_ sender: (any NSDraggingInfo)?) {
        if let sender, carriesFiles(sender) { return }
        super.concludeDragOperation(sender)
    }
}

/// Les fichiers joints d'une feuille, reçus d'un glissé ou de « Ajouter des fichiers… ». Ceux du Finder gardent leur
/// chemin (le moteur les copie au lancement). Ceux que Mail ou Safari promettent n'existent pas encore : l'app d'origine
/// les écrit tout de suite dans un dossier à Vigie (sous le dossier temporaire du Mac, un sous-dossier par dépôt, nom
/// d'origine gardé). Ce que le moteur ne pourrait pas lire lui-même (Bureau, Documents, Téléchargements, iCloud Drive,
/// Dropbox, disque externe : AgentAttachment.needsCopy) y est copié aussi.
/// Le dossier est effacé quand la feuille se ferme : le moteur a déjà tout copié dans sources/.
@MainActor
final class AgentDropBox {
    static var dragTypes: [NSPasteboard.PasteboardType] {
        [.fileURL] + NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }
    }

    /// Le glissé porte des fichiers (Finder) ou des fichiers promis (pièces jointes de Mail, images de Safari).
    static func carriesFiles(_ pasteboard: NSPasteboard) -> Bool {
        pasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
            || pasteboard.canReadObject(forClasses: [NSFilePromiseReceiver.self], options: nil)
    }

    private let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
        .appending(path: "vigie-fichiers-joints/\(UUID().uuidString)", directoryHint: .isDirectory)
    private var folders = 0
    private var receivers: [NSFilePromiseReceiver] = []
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.qualityOfService = .userInitiated
        return queue
    }()

    /// Ce qu'apporte un glissé : `deliver` reçoit les fichiers joints au fur et à mesure (un fichier promis arrive
    /// quand l'app d'origine l'a écrit), ou la phrase de ce qui n'a pas pu l'être.
    func receive(_ pasteboard: NSPasteboard, deliver: @escaping @MainActor @Sendable ([AgentAttachment], String?) -> Void) {
        let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if !urls.isEmpty {
            Task { deliver(await attach(urls), nil) }
            return
        }
        let promised = pasteboard.readObjects(forClasses: [NSFilePromiseReceiver.self], options: nil) as? [NSFilePromiseReceiver] ?? []
        for receiver in promised {
            guard let folder = nextFolder() else {
                deliver([], Self.notJoined(receiver.fileNames.first))
                continue
            }
            receivers.append(receiver) // gardé jusqu'à la fermeture de la feuille, le temps que l'app d'origine écrive
            receiver.receivePromisedFiles(atDestination: folder, options: [:], operationQueue: queue) { url, error in
                let item = error == nil ? AgentAttachment.read(url, isCopy: true) : nil
                let issue = item == nil ? Self.notJoined(url.lastPathComponent) : nil
                Task { @MainActor in deliver(item.map { [$0] } ?? [], issue) }
            }
        }
    }

    /// Des fichiers choisis ou glissés du Finder ; ceux que le moteur ne pourrait pas lire sont copiés d'abord (hors de l'app, un gros
    /// fichier ne fige rien).
    func attach(_ urls: [URL]) async -> [AgentAttachment] {
        var items: [AgentAttachment] = []
        for url in urls {
            guard let item = AgentAttachment.read(url) else { continue }
            guard AgentAttachment.needsCopy(item.path, isFolder: item.isFolder) else {
                items.append(item)
                continue
            }
            guard let folder = nextFolder() else { continue }
            let target = folder.appending(path: item.name)
            let copied = await Task.detached(priority: .userInitiated) {
                (try? FileManager.default.copyItem(at: url, to: target)) == nil ? nil : AgentAttachment.read(target, isCopy: true)
            }.value
            if let copied { items.append(copied) }
        }
        return items
    }

    /// Un fichier retiré de la liste : sa copie (s'il en a une) est effacée.
    func discard(_ item: AgentAttachment) {
        guard item.isCopy else { return }
        let folder = URL(filePath: item.path).deletingLastPathComponent()
        guard folder.path(percentEncoded: false).hasPrefix(root.path(percentEncoded: false)) else { return }
        try? FileManager.default.removeItem(at: folder)
    }

    /// La feuille se ferme : toutes les copies s'effacent.
    func clear() {
        try? FileManager.default.removeItem(at: root)
    }

    /// Un sous-dossier neuf, à toi seul (0700) : deux pièces jointes du même nom gardent chacune le sien.
    private func nextFolder() -> URL? {
        folders += 1
        let folder = root.appending(path: String(folders), directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            return folder
        } catch {
            return nil
        }
    }

    private nonisolated static func notJoined(_ name: String?) -> String {
        let what = name.map { "« \($0) »" } ?? "Ce fichier"
        return "\(what) n'a pas pu être joint : enregistre-le d'abord (dans Téléchargements par exemple), puis glisse-le depuis le Finder."
    }
}
