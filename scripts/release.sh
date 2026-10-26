#!/bin/bash
# Prépare une version publiable. Usage : scripts/release.sh 0.3.0
#   dist/vigie.tar.gz : moteur + app, pour les mises à jour automatiques et la commande Terminal ;
#   dist/Vigie.dmg    : l'app à glisser dans Applications (téléchargement depuis un site).
# L'app embarque le moteur (Contents/Resources/engine) : glissée dans Applications, elle l'installe elle-même.
# Signature : premier certificat « Developer ID Application » du trousseau (ou VIGIE_SIGN_ID) ; notarisation par
# Apple avec le profil enregistré par `xcrun notarytool store-credentials` (VIGIE_NOTARY_PROFILE, par défaut
# « vigie-notarisation »). Sans certificat : signature locale seulement ; sans profil : pas de notarisation
# (l'app s'ouvrirait avec une alerte une fois téléchargée : à ne pas publier ainsi).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:?version, par exemple 0.3.0}"
PROFILE="${VIGIE_NOTARY_PROFILE:-vigie-notarisation}"
cd "$ROOT"
APP="$ROOT/mac/Vigie.app"
ENGINE_FILES=(VERSION hook.mjs server.mjs lib bin scripts public README.md LICENSE)

echo "1/6 Tests du moteur"
node --test test/ >/dev/null || { echo "Des tests échouent : rien n'est publié." >&2; exit 1; }
echo "$VERSION" > VERSION

echo "2/6 App (universelle)"
VIGIE_UNIVERSAL=1 VIGIE_VERSION="$VERSION" ./mac/build-app.sh >/dev/null

echo "3/6 Moteur embarqué dans l'app"
ENGINE="$APP/Contents/Resources/engine"
rm -rf "$ENGINE"
mkdir -p "$ENGINE"
rsync -a --exclude '.DS_Store' "${ENGINE_FILES[@]}" "$ENGINE/"

echo "4/6 Signature et notarisation de l'app"
SIGN_ID="${VIGIE_SIGN_ID:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"
NOTARIZE=
if [ -n "$SIGN_ID" ]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP"
  codesign --verify --strict --deep "$APP"
  if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then NOTARIZE=1; else
    echo "  ! profil de notarisation « $PROFILE » absent : app signée mais pas notarisée (ne pas publier)"
  fi
else
  echo "  ! aucun certificat Developer ID : signature locale seulement (ne pas publier)"
  codesign --force --sign - "$APP"
fi
mkdir -p dist
if [ -n "$NOTARIZE" ]; then
  ditto -c -k --keepParent "$APP" dist/Vigie-notarisation.zip
  OUT="$(xcrun notarytool submit dist/Vigie-notarisation.zip --keychain-profile "$PROFILE" --wait --timeout 30m 2>&1)"
  echo "$OUT" | tail -2
  echo "$OUT" | grep -q "status: Accepted" || { echo "Notarisation refusée : voir xcrun notarytool log <id> --keychain-profile $PROFILE" >&2; exit 1; }
  xcrun stapler staple "$APP" >/dev/null
  rm -f dist/Vigie-notarisation.zip
fi
# Les Vigie installés refusent une app d'une autre équipe ou non notarisée (lib/update.mjs, install.sh) : une telle
# version ne se publie pas. VIGIE_LOCAL=1 : essai local, sans publier.
TEAM_ID="CQ43U6XX4Z" # même valeur que TEAM_ID de lib/update.mjs
if [ -z "${VIGIE_LOCAL:-}" ]; then
  [ -n "$NOTARIZE" ] || { echo "App non notarisée : rien à publier (VIGIE_LOCAL=1 pour un essai local)." >&2; exit 1; }
  SIG="$(codesign -dv --verbose=2 "$APP" 2>&1 || true)"
  { printf '%s\n' "$SIG" | grep -qx "TeamIdentifier=$TEAM_ID" && spctl --assess --type execute "$APP" 2>/dev/null; } \
    || { echo "App non signée par l'équipe de Vigie ou refusée par Gatekeeper : rien à publier." >&2; exit 1; }
fi

echo "5/6 Archive des mises à jour"
tar -czf dist/vigie.tar.gz --exclude '.DS_Store' --exclude 'docs/images' "${ENGINE_FILES[@]}" docs mac/Vigie.app

echo "6/6 Image disque (Vigie.dmg)"
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Vigie.app"
ln -s /Applications "$STAGE/Applications"
rm -f dist/Vigie.dmg
hdiutil create -volname "Vigie" -srcfolder "$STAGE" -ov -format ULFO dist/Vigie.dmg >/dev/null
find "$STAGE" -delete 2>/dev/null || true
if [ -n "$SIGN_ID" ]; then codesign --force --timestamp --sign "$SIGN_ID" dist/Vigie.dmg; fi
if [ -n "$NOTARIZE" ]; then
  OUT="$(xcrun notarytool submit dist/Vigie.dmg --keychain-profile "$PROFILE" --wait --timeout 30m 2>&1)"
  echo "$OUT" | tail -2
  echo "$OUT" | grep -q "status: Accepted" || { echo "Notarisation du DMG refusée" >&2; exit 1; }
  xcrun stapler staple dist/Vigie.dmg >/dev/null
  spctl --assess --type open --context context:primary-signature -v dist/Vigie.dmg 2>&1 | tail -1
fi
echo "Prêt : dist/vigie.tar.gz ($(du -h dist/vigie.tar.gz | cut -f1)), dist/Vigie.dmg ($(du -h dist/Vigie.dmg | cut -f1)) — version $VERSION$([ -n "$NOTARIZE" ] && echo ', signée et notarisée' || echo ', NON notarisée')"
