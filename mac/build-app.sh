#!/bin/bash
# Compile Vigie.app (SwiftUI, Liquid Glass, macOS 26+) depuis le paquet SwiftPM VigieApp.
# Construction atomique : l'ancienne Vigie.app n'est remplacée qu'une fois la nouvelle compilée,
# empaquetée et signée. En cas d'échec, l'ancienne reste en place.
#
# Usage : mac/build-app.sh
# Essai sans moteur : VIGIE_FIXTURES=mac/VigieApp/Preview mac/Vigie.app/Contents/MacOS/Vigie
# Captures d'écran : VIGIE_FIXTURES=… mac/Vigie.app/Contents/MacOS/Vigie --snapshot <dossier>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/VigieApp"
APP="$HERE/Vigie.app"

STAGE_ROOT="$PKG/.build/app-stage"
mkdir -p "$STAGE_ROOT"
STAGE="$(mktemp -d "$STAGE_ROOT/build.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

fail() {
  echo "Échec : $1. L'ancienne app reste en place." >&2
  exit 1
}

echo "1/4 Compilation"
LOG="$STAGE/build.log"
# VIGIE_UNIVERSAL=1 : Mac Apple Silicon et Intel dans le même exécutable (publication).
ARCH_ARGS=()
if [ -n "${VIGIE_UNIVERSAL:-}" ]; then ARCH_ARGS=(--arch arm64 --arch x86_64); fi
if ! swift build --package-path "$PKG" -c release "${ARCH_ARGS[@]+"${ARCH_ARGS[@]}"}" 2>&1 | tee "$LOG"; then
  fail "la compilation n'a pas abouti"
fi
WARNINGS="$(grep -c "warning:" "$LOG" || true)"
BIN_DIR="$(swift build --package-path "$PKG" -c release "${ARCH_ARGS[@]+"${ARCH_ARGS[@]}"}" --show-bin-path)"
BIN="$BIN_DIR/Vigie"
[ -x "$BIN" ] || fail "exécutable introuvable ($BIN)"

echo "2/4 Icône"
xcrun swiftc -O "$PKG/Tools/make-icon.swift" -o "$STAGE/make-icon" || fail "outil d'icône"
"$STAGE/make-icon" "$STAGE/Vigie.iconset" || fail "dessin de l'icône"
iconutil -c icns "$STAGE/Vigie.iconset" -o "$STAGE/Vigie.icns" || fail "iconutil"

echo "3/4 Paquet et signature"
BUNDLE="$STAGE/Vigie.app"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$BIN" "$BUNDLE/Contents/MacOS/Vigie"
cp "$STAGE/Vigie.icns" "$BUNDLE/Contents/Resources/Vigie.icns"
VERSION="$(date +%Y%m%d%H%M)"
cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Vigie</string>
  <key>CFBundleDisplayName</key><string>Vigie</string>
  <key>CFBundleIdentifier</key><string>io.github.paulmailhes.vigie</string>
  <key>CFBundleExecutable</key><string>Vigie</string>
  <key>CFBundleIconFile</key><string>Vigie</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VIGIE_VERSION:-0.1.0}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleDevelopmentRegion</key><string>fr</string>
  <key>CFBundleLocalizations</key><array><string>fr</string></array>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST
plutil -lint "$BUNDLE/Contents/Info.plist" >/dev/null || fail "Info.plist invalide"
codesign --force --sign - --timestamp=none "$BUNDLE" || fail "signature"
codesign --verify --strict "$BUNDLE" || fail "vérification de la signature"

echo "4/4 Remplacement"
OLD="$STAGE/Vigie-precedente.app"
if [ -e "$APP" ]; then
  mv "$APP" "$OLD" || fail "mise de côté de l'ancienne app"
fi
if ! mv "$BUNDLE" "$APP"; then
  [ -e "$OLD" ] && mv "$OLD" "$APP"
  fail "installation de la nouvelle app"
fi

echo "App compilée : $APP (avertissements : $WARNINGS)"
