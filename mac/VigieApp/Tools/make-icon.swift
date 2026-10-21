// Dessine l'icône de Vigie (des jumelles sur un fond de nuit) et écrit un dossier .iconset.
// Usage : make-icon <dossier.iconset>   (puis : iconutil -c icns <dossier.iconset>)
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage : make-icon <dossier.iconset>\n".utf8))
    exit(1)
}
let outputFolder = URL(filePath: arguments[1], directoryHint: .isDirectory)

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

func linear(_ context: CGContext, in path: CGPath, colors: [CGColor], from start: CGPoint, to end: CGPoint) {
    context.saveGState()
    context.addPath(path)
    context.clip()
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: nil)!
    context.drawLinearGradient(gradient, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    context.restoreGState()
}

func radial(_ context: CGContext, in path: CGPath, colors: [CGColor], locations: [CGFloat], center: CGPoint, radius: CGFloat) {
    context.saveGState()
    context.addPath(path)
    context.clip()
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: locations)!
    context.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius,
                               options: [.drawsAfterEndLocation])
    context.restoreGState()
}

func roundedRect(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

func circle(_ center: CGPoint, _ radius: CGFloat) -> CGPath {
    CGPath(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2), transform: nil)
}

/// Dessine l'icône dans un repère 1024 × 1024 (origine en bas à gauche).
func drawIcon(_ context: CGContext) {
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let bodyPath = roundedRect(body, 185)

    // Ombre portée du carré, comme les icônes du Mac.
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: color(0x000000, 0.45))
    context.addPath(bodyPath)
    context.setFillColor(color(0x0A1030))
    context.fillPath()
    context.restoreGState()

    // Ciel de nuit : dégradé et halo de lune.
    linear(context, in: bodyPath, colors: [color(0x26357A), color(0x121A45), color(0x060918)],
           from: CGPoint(x: 512, y: 924), to: CGPoint(x: 512, y: 100))
    radial(context, in: bodyPath, colors: [color(0x6E7FD6, 0.55), color(0x6E7FD6, 0)], locations: [0, 1],
           center: CGPoint(x: 760, y: 790), radius: 330)

    // Étoiles (tirage fixe).
    context.saveGState()
    context.addPath(bodyPath)
    context.clip()
    var seed: UInt64 = 0x5EED_1E5
    func next() -> CGFloat {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        return CGFloat((seed >> 33) % 10_000) / 10_000
    }
    for _ in 0..<70 {
        let point = CGPoint(x: 120 + next() * 784, y: 420 + next() * 490)
        let radius = 1.6 + next() * 3.6
        context.setFillColor(color(0xFFFFFF, 0.35 + next() * 0.6))
        context.addPath(circle(point, radius))
        context.fillPath()
    }
    // Quelques étoiles qui scintillent (croix fines).
    for star in [CGPoint(x: 250, y: 820), CGPoint(x: 590, y: 860), CGPoint(x: 880, y: 560)] {
        context.setStrokeColor(color(0xFFFFFF, 0.8))
        context.setLineWidth(3)
        context.setLineCap(.round)
        context.move(to: CGPoint(x: star.x - 14, y: star.y))
        context.addLine(to: CGPoint(x: star.x + 14, y: star.y))
        context.move(to: CGPoint(x: star.x, y: star.y - 14))
        context.addLine(to: CGPoint(x: star.x, y: star.y + 14))
        context.strokePath()
    }

    // Croissant de lune.
    let moon = circle(CGPoint(x: 770, y: 790), 64)
    let bite = circle(CGPoint(x: 800, y: 812), 58)
    context.saveGState()
    context.addPath(moon)
    context.addPath(bite)
    context.clip(using: .evenOdd)
    context.addPath(moon)
    context.setFillColor(color(0xFBEFC4))
    context.fillPath()
    context.restoreGState()
    context.restoreGState()

    // Jumelles, vues de face.
    let left: CGFloat = 512 - 168
    let right: CGFloat = 512 + 168
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: color(0x000000, 0.55))

    // Oculaires.
    for x in [left, right] {
        let eyepiece = roundedRect(CGRect(x: x - 78, y: 610, width: 156, height: 150), 44)
        linear(context, in: eyepiece, colors: [color(0x5A6488), color(0x2C3352)],
               from: CGPoint(x: x, y: 760), to: CGPoint(x: x, y: 610))
    }
    // Corps (deux fûts).
    for x in [left, right] {
        let barrel = roundedRect(CGRect(x: x - 126, y: 250, width: 252, height: 400), 104)
        context.addPath(barrel)
        context.setFillColor(color(0xC9D0E0))
        context.fillPath()
        linear(context, in: barrel, colors: [color(0xF7F8FC), color(0xC4CBDD), color(0x98A2BC)],
               from: CGPoint(x: x - 126, y: 650), to: CGPoint(x: x + 126, y: 250))
    }
    context.restoreGState()

    // Pont central et molette.
    let bridge = roundedRect(CGRect(x: 512 - 96, y: 470, width: 192, height: 120), 36)
    linear(context, in: bridge, colors: [color(0xE4E8F2), color(0xA8B1C8)],
           from: CGPoint(x: 512, y: 590), to: CGPoint(x: 512, y: 470))
    let knob = circle(CGPoint(x: 512, y: 640), 50)
    linear(context, in: knob, colors: [color(0x7C87A8), color(0x3E4766)],
           from: CGPoint(x: 512, y: 690), to: CGPoint(x: 512, y: 590))
    context.setStrokeColor(color(0x2A3150, 0.6))
    context.setLineWidth(5)
    for offset in stride(from: -30.0, through: 30.0, by: 15.0) {
        context.move(to: CGPoint(x: 512 + offset, y: 606))
        context.addLine(to: CGPoint(x: 512 + offset, y: 674))
    }
    context.strokePath()

    // Objectifs : bague sombre, verre bleu de nuit, reflet.
    for x in [left, right] {
        let center = CGPoint(x: x, y: 372)
        context.addPath(circle(center, 120))
        context.setFillColor(color(0x1E2440))
        context.fillPath()
        context.addPath(circle(center, 120))
        context.setStrokeColor(color(0xFFFFFF, 0.18))
        context.setLineWidth(4)
        context.strokePath()
        radial(context, in: circle(center, 96),
               colors: [color(0x9BE3FF), color(0x3D7BE0), color(0x16245E), color(0x070B1F)],
               locations: [0, 0.28, 0.7, 1],
               center: CGPoint(x: x - 26, y: 398), radius: 118)
        // Reflet principal.
        context.saveGState()
        context.addPath(circle(center, 96))
        context.clip()
        context.addPath(CGPath(ellipseIn: CGRect(x: x - 70, y: 400, width: 74, height: 40), transform: nil))
        context.setFillColor(color(0xFFFFFF, 0.55))
        context.fillPath()
        context.addPath(circle(CGPoint(x: x + 38, y: 334), 11))
        context.setFillColor(color(0xFFFFFF, 0.35))
        context.fillPath()
        context.restoreGState()
    }
}

func render(size: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    let context = graphics.cgContext
    context.interpolationQuality = .high
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    context.clear(CGRect(x: 0, y: 0, width: size, height: size))
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    drawIcon(context)
    graphics.flushGraphics()
    return rep.representation(using: .png, properties: [:])
}

do {
    try FileManager.default.createDirectory(at: outputFolder, withIntermediateDirectories: true)
    let entries: [(String, Int)] = [
        ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
        ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
        ("icon_512x512", 512), ("icon_512x512@2x", 1024),
    ]
    for (name, size) in entries {
        guard let data = render(size: size) else { throw CocoaError(.fileWriteUnknown) }
        try data.write(to: outputFolder.appending(path: "\(name).png"))
    }
} catch {
    FileHandle.standardError.write(Data("échec de l'icône : \(error.localizedDescription)\n".utf8))
    exit(1)
}
