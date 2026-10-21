#!/bin/bash
# Met Vigie en place à partir de fichiers déjà là : l'archive téléchargée par install.sh (Terminal, mises à jour),
# ou le moteur livré dans l'app (Vigie.app/Contents/Resources/engine) au premier lancement de l'app.
#   1. Node.js 20 ou plus récent : celui du Mac, sinon une copie officielle vérifiée dans ~/.vigie/node ;
#   2. le moteur copié dans ~/.vigie (data/ et node/ gardés : réglages, historique, comptes) ;
#   3. l'app fournie (mac/Vigie.app de l'archive) remplace l'app installée : celle glissée dans Applications
#      (VIGIE_APP, ou ~/.vigie/data/app.path) ; sinon elle va dans ~/.vigie/mac (installation par Terminal) ;
#   4. scripts/install.sh : hooks, lancement au démarrage.
# Variables : VIGIE_HOME, VIGIE_APP, VIGIE_FROM_APP (lancé par l'app : pas d'ouverture), VIGIE_UPDATE (mise à jour :
# l'app est relancée), VIGIE_DRY_RUN (essai), VIGIE_OWN_NODE (toujours la copie de Node.js de Vigie).
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${VIGIE_HOME:-$HOME/.vigie}"
say() { printf '%s\n' "$*"; }
stop() { printf '\n%s\n' "$*" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'find "$TMP" -delete 2>/dev/null || true' EXIT

# 1. Node.js : celui du PATH, sinon les emplacements habituels (Homebrew, Volta, nvm), sinon la copie de Vigie.
node_ok() { [ -n "$1" ] && [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
find_node() {
  local c
  for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
           $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1) "$DEST/node/bin/node"; do
    node_ok "$c" && { echo "$c"; return 0; }
  done
  return 1
}
install_node() {
  local arch line sum file
  case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=x64 ;; esac
  say "… Node.js 20 ou plus récent est introuvable : installation de sa propre copie (Node.js LTS) dans $DEST/node"
  line="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -E "  node-v[0-9.]+-darwin-$arch\.tar\.gz$" | head -1)" \
    || stop "Impossible de joindre nodejs.org. Installe Node.js toi-même (https://nodejs.org), puis relance."
  sum="${line%% *}"; file="${line##* }"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$file" -o "$TMP/$file" || stop "Téléchargement de Node.js impossible."
  [ "$(shasum -a 256 "$TMP/$file" | cut -d' ' -f1)" = "$sum" ] || stop "Node.js téléchargé ne correspond pas à son empreinte officielle : installation arrêtée."
  mkdir -p "$TMP/node" "$DEST"
  tar -xzf "$TMP/$file" -C "$TMP/node" --strip-components 1 || stop "Archive de Node.js illisible."
  rsync -a --delete "$TMP/node/" "$DEST/node/"
}
NODE=""
if [ -z "${VIGIE_OWN_NODE:-}" ]; then NODE="$(find_node || true)"; elif node_ok "$DEST/node/bin/node"; then NODE="$DEST/node/bin/node"; fi
if [ -z "$NODE" ]; then
  install_node
  NODE="$DEST/node/bin/node"
  node_ok "$NODE" || stop "La copie de Node.js ne démarre pas ($NODE)."
fi
say "✓ Node.js $("$NODE" -v) ($NODE)"

# 2. Le moteur : tout est remplacé, sauf data/ (réglages, historique, comptes), node/ (sa copie de Node.js) et
#    mac/ (l'app, traitée à part).
[ -f "$SRC/server.mjs" ] || stop "Fichiers de Vigie incomplets ($SRC)."
mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  rsync -a --delete --exclude data --exclude node --exclude mac "$SRC/" "$DEST/"
fi
say "✓ Vigie est dans $DEST"

# 3. L'app. Celle glissée dans Applications est remplacée sur place (nouvelle copie à côté, puis échange) ;
#    sinon, celle de l'installation par Terminal, dans ~/.vigie/mac.
APP="${VIGIE_APP:-}"
if [ -z "$APP" ] && [ -f "$DEST/data/app.path" ]; then APP="$(cat "$DEST/data/app.path")"; fi
[ -n "$APP" ] || APP="$DEST/mac/Vigie.app"
if [ -d "$SRC/mac/Vigie.app" ]; then
  if [ "$APP" = "$DEST/mac/Vigie.app" ]; then
    mkdir -p "$DEST/mac"
    rsync -a --delete "$SRC/mac/Vigie.app/" "$APP/"
  elif [ -z "${VIGIE_DRY_RUN:-}" ]; then
    PARENT="$(dirname "$APP")"
    [ -w "$PARENT" ] || stop "Impossible de remplacer l'app dans $PARENT : télécharge de nouveau Vigie et glisse-la dans Applications."
    NEW="$PARENT/.Vigie-nouvelle-$$.app"
    OLD="$PARENT/.Vigie-ancienne-$$.app"
    ditto "$SRC/mac/Vigie.app" "$NEW" || stop "Copie de la nouvelle app impossible."
    if [ -d "$APP" ]; then mv "$APP" "$OLD"; fi
    mv "$NEW" "$APP" || { [ -d "$OLD" ] && mv "$OLD" "$APP"; stop "Remplacement de l'app impossible : l'ancienne est gardée."; }
    [ -d "$OLD" ] && rm -rf "$OLD"
  fi
  say "✓ App : $APP"
fi
# App glissée dans Applications : l'ancienne copie de l'installation par Terminal (et son raccourci) disparaît,
# sinon deux Vigie se côtoient dans Spotlight.
if [ "$APP" != "$DEST/mac/Vigie.app" ] && [ -z "${VIGIE_DRY_RUN:-}" ]; then
  if [ -L "$HOME/Applications/Vigie.app" ] && [ "$(readlink "$HOME/Applications/Vigie.app")" = "$DEST/mac/Vigie.app" ]; then
    rm -f "$HOME/Applications/Vigie.app"
  fi
  [ -d "$DEST/mac" ] && rm -rf "$DEST/mac"
fi

# 4. Hooks et lancement au démarrage.
VIGIE_PREBUILT=1 VIGIE_NODE="$NODE" VIGIE_APP="$APP" "$DEST/scripts/install.sh"
