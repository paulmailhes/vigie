import CoreGraphics
import Foundation
// Affiche « id x y largeur hauteur » de la plus grande fenêtre normale du processus donné.
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
var best: (Int, CGRect)? = nil
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
  guard let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
  let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
  if best == nil || r.width * r.height > best!.1.width * best!.1.height { best = (w[kCGWindowNumber as String] as? Int ?? 0, r) }
}
if let (id, r) = best { print(id, Int(r.minX), Int(r.minY), Int(r.width), Int(r.height)) }
