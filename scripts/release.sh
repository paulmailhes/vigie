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
ENGINE_FILES=(VERSION hook.mjs server.mjs lib bin scripts public agents README.md LICENSE)

# Ce qui part dans l'app (moteur embarqué) et dans l'archive publique : seulement ce que suit git. Un fichier laissé
# hors du dépôt dans ces dossiers (note de travail, essai) arrête la publication au lieu de partir avec elle. VERSION
# est écrit par ce script ; .DS_Store est écarté par rsync et tar.
LOOSE="$(git ls-files --others -- "${ENGINE_FILES[@]}" | grep -v -e '^VERSION$' -e '\(^\|/\)\.DS_Store$' || true)"
if [ -n "$LOOSE" ]; then
  printf 'Fichiers non suivis par git qui partiraient dans la version :\n%s\n' "$LOOSE" >&2
  echo "Rien n'est publié : commite-les ou sors-les du dépôt." >&2
  exit 1
fi
# La documentation : seulement les fichiers suivis par git (sans les captures du README). Un fichier de docs/ laissé
# hors du dépôt n'y part pas. Une boucle plutôt que mapfile : bash 3.2 sur macOS.
DOCS=()
while IFS= read -r -d '' f; do DOCS+=("$f"); done < <(git ls-files -z -- docs ':!:docs/images')

# Notarise un fichier. `notarytool --timeout` ne couvre que l'attente de la réponse d'Apple : un envoi bloqué ne s'arrête
# jamais. Chaque essai a donc sa limite (NOTARY_TRY_SECONDS, 10 min), et un essai sans réponse recommence, deux fois au
# plus. Un refus d'Apple ne se réessaie pas.
notarize() {
  local file="$1" log pid watcher try
  log="$(mktemp)"
  for try in 1 2 3; do
    xcrun notarytool submit "$file" --keychain-profile "$PROFILE" --wait --timeout 8m >"$log" 2>&1 &
    pid=$!
    ( sleep "${NOTARY_TRY_SECONDS:-600}"; kill "$pid" 2>/dev/null ) &
    watcher=$!
    wait "$pid" || true
    pkill -P "$watcher" 2>/dev/null || true
    kill "$watcher" 2>/dev/null || true
    wait "$watcher" 2>/dev/null || true
    tail -2 "$log"
    if grep -q "status: Accepted" "$log"; then rm -f "$log"; return 0; fi
    grep -Eq "status: (Invalid|Rejected)" "$log" && break
    echo "  ! essai $try sans réponse d'Apple pour $(basename "$file")" >&2
  done
  rm -f "$log"
  return 1
}

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

# Chaque panneau de chaque conversation, à plusieurs largeurs de fenêtre : une boucle de mise en page fait planter
# l'app (exception d'AppKit), et une telle version ne sort pas. VIGIE_NO_STRESS=1 pour s'en passer.
if [ -z "${VIGIE_NO_STRESS:-}" ]; then
  echo "    Essai de mise en page (fenêtre de Vigie à l'écran, environ 2 min)"
  STRESS="$(mktemp -d)"
  VIGIE_STRESS=1 VIGIE_FIXTURES="$ROOT/mac/VigieApp/Preview" "$APP/Contents/MacOS/Vigie" --snapshot "$STRESS" >"$STRESS/journal.txt" 2>&1 \
    || { grep -m1 'Terminating app' "$STRESS/journal.txt" >&2 || true; echo "L'app plante à l'ouverture d'un panneau : rien n'est publié." >&2; exit 1; }
fi

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
  notarize dist/Vigie-notarisation.zip || { echo "Notarisation refusée : voir xcrun notarytool log <id> --keychain-profile $PROFILE" >&2; exit 1; }
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
tar -czf dist/vigie.tar.gz --exclude '.DS_Store' "${ENGINE_FILES[@]}" ${DOCS[@]+"${DOCS[@]}"} mac/Vigie.app
# Contrôle : hors de l'app et de VERSION, l'archive (publique) ne contient que des fichiers suivis par git.
STRAY="$(tar -tzf dist/vigie.tar.gz | grep -v -e '/$' -e '^mac/Vigie\.app/' -e '^VERSION$' | grep -vxF -f <(git -c core.quotePath=false ls-files) || true)"
if [ -n "$STRAY" ]; then
  printf 'Fichiers non suivis par git dans dist/vigie.tar.gz :\n%s\n' "$STRAY" >&2
  rm -f dist/vigie.tar.gz
  echo "Rien n'est publié." >&2
  exit 1
fi

echo "6/6 Image disque (Vigie.dmg)"
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Vigie.app"
ln -s /Applications "$STAGE/Applications"
rm -f dist/Vigie.dmg
hdiutil create -volname "Vigie" -srcfolder "$STAGE" -ov -format ULFO dist/Vigie.dmg >/dev/null
find "$STAGE" -delete 2>/dev/null || true
if [ -n "$SIGN_ID" ]; then codesign --force --timestamp --sign "$SIGN_ID" dist/Vigie.dmg; fi
# Une image restée attachée au système (vu après hdiutil create, sans disque visible dans le Finder) reste verrouillée :
# notarytool se bloque à son ouverture, sans rien envoyer et sans jamais s'arrêter.
ATTACHED="$(hdiutil info 2>/dev/null | awk -v f="$ROOT/dist/Vigie.dmg" '/^image-path/{on=(index($0,f)>0)} on&&/^\/dev\/disk[0-9]+[ \t]/{print $1; exit}')"
if [ -n "$ATTACHED" ]; then hdiutil detach "$ATTACHED" >/dev/null 2>&1 || hdiutil detach -force "$ATTACHED" >/dev/null 2>&1 || true; fi
if [ -n "$NOTARIZE" ]; then
  notarize dist/Vigie.dmg || { echo "Notarisation du DMG refusée" >&2; exit 1; }
  xcrun stapler staple dist/Vigie.dmg >/dev/null
  spctl --assess --type open --context context:primary-signature -v dist/Vigie.dmg 2>&1 | tail -1
fi
echo "Prêt : dist/vigie.tar.gz ($(du -h dist/vigie.tar.gz | cut -f1)), dist/Vigie.dmg ($(du -h dist/Vigie.dmg | cut -f1)) — version $VERSION$([ -n "$NOTARIZE" ] && echo ', signée et notarisée' || echo ', NON notarisée')"
