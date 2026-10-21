// swift-tools-version: 6.2
// Vigie pour Mac : l'app SwiftUI qui affiche et règle le moteur de Vigie (API v2, 127.0.0.1:4777).
// Compilée en Vigie.app par ../build-app.sh.
import PackageDescription

let package = Package(
    name: "Vigie",
    defaultLocalization: "fr",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(
            name: "Vigie",
            path: "Sources/Vigie",
            swiftSettings: [
                .swiftLanguageMode(.v6)
            ]
        ),
        .testTarget(
            name: "VigieTests",
            dependencies: ["Vigie"],
            path: "Tests/VigieTests",
            swiftSettings: [
                .swiftLanguageMode(.v6)
            ]
        ),
    ]
)
