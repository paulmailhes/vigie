#!/bin/bash
# Vigie : installation en une commande.
#
#   curl -fsSL https://raw.githubusercontent.com/paulmailhes/vigie/main/install.sh | bash
#
# Ce que fait ce script :
#   1. vérifie le Mac (macOS 26 ou plus récent) et Node.js (version 20 ou plus récente) ; sans Node.js, installe
#      sa propre copie (version LTS officielle, vérifiée) dans ~/.vigie/node, sans toucher au reste du Mac ;
#   2. télécharge la dernière version de Vigie (moteur + app déjà construite) dans ~/.vigie ;
#   3. branche le hook dans Claude Code, lance le moteur et l'app au démarrage du Mac ;
#   4. ouvre Vigie, qui t'accueille et te guide.
# Relancer la même commande met Vigie à jour ; tes réglages et ton historique (~/.vigie/data) sont gardés.
# Tout retirer : ~/.vigie/scripts/uninstall.sh
set -euo pipefail

REPO="paulmailhes/vigie"
DEST="${VIGIE_HOME:-$HOME/.vigie}"
URL="${VIGIE_TARBALL:-https://github.com/$REPO/releases/latest/download/vigie.tar.gz}"

say() { printf '%s\n' "$*"; }
stop() { printf '\n%s\n' "$*" >&2; exit 1; }

say "Installation de Vigie"
say ""

# 1. Le Mac
[ "$(uname -s)" = "Darwin" ] || stop "Vigie ne fonctionne que sur Mac."
MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MAJOR" -ge 26 ] || stop "Vigie demande macOS 26 ou plus récent (ce Mac : $(sw_vers -productVersion))."

# Node.js 20 ou plus récent : celui du PATH, sinon les emplacements habituels (Homebrew, Volta, nvm), sinon la copie
# de Vigie (~/.vigie/node). Aucun ne convient : Vigie installe la sienne, sans droits administrateur.
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
    || stop "Impossible de joindre nodejs.org. Installe Node.js toi-même (https://nodejs.org), puis relance cette commande."
  sum="${line%% *}"; file="${line##* }"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$file" -o "$TMP/$file" || stop "Téléchargement de Node.js impossible."
  [ "$(shasum -a 256 "$TMP/$file" | cut -d' ' -f1)" = "$sum" ] || stop "Node.js téléchargé ne correspond pas à son empreinte officielle : installation arrêtée."
  mkdir -p "$TMP/node" "$DEST"
  tar -xzf "$TMP/$file" -C "$TMP/node" --strip-components 1 || stop "Archive de Node.js illisible."
  rsync -a --delete "$TMP/node/" "$DEST/node/"
}
TMP="$(mktemp -d)"
trap 'find "$TMP" -delete 2>/dev/null || true' EXIT
# VIGIE_OWN_NODE=1 : toujours la copie de Vigie, même si le Mac a déjà Node.js (essais).
NODE=""
if [ -z "${VIGIE_OWN_NODE:-}" ]; then NODE="$(find_node || true)"; elif node_ok "$DEST/node/bin/node"; then NODE="$DEST/node/bin/node"; fi
if [ -z "$NODE" ]; then
  install_node
  NODE="$DEST/node/bin/node"
  node_ok "$NODE" || stop "La copie de Node.js ne démarre pas ($NODE)."
fi
say "✓ macOS $(sw_vers -productVersion), Node.js $("$NODE" -v) ($NODE)"

if [ ! -d "$HOME/.claude" ]; then
  say "! Claude Code ne semble pas encore installé (pas de dossier ~/.claude). Vigie s'installe quand même :"
  say "  il veillera dès que tu utiliseras Claude Code."
fi

# 2. Téléchargement (curl ne pose pas d'attribut de quarantaine : l'app s'ouvre sans alerte de Gatekeeper)
say "… téléchargement de Vigie"
curl -fsSL "$URL" -o "$TMP/vigie.tar.gz" || stop "Téléchargement impossible ($URL)."
mkdir -p "$TMP/x"
tar -xzf "$TMP/vigie.tar.gz" -C "$TMP/x" || stop "Archive illisible."
[ -f "$TMP/x/server.mjs" ] && [ -d "$TMP/x/mac/Vigie.app" ] || stop "Archive incomplète."

mkdir -p "$DEST"
# Mise à jour : tout est remplacé, sauf data/ (réglages, historique, comptes) et node/ (sa copie de Node.js).
rsync -a --delete --exclude data --exclude node "$TMP/x/" "$DEST/"
say "✓ Vigie est dans $DEST"

# 3. Hook, moteur, app au démarrage
VIGIE_PREBUILT=1 VIGIE_NODE="$NODE" "$DEST/scripts/install.sh"

# 4. L'app (VIGIE_DRY_RUN : essai, rien n'est relié ni ouvert)
if [ -z "${VIGIE_DRY_RUN:-}" ]; then
  mkdir -p "$HOME/Applications"
  ln -sfn "$DEST/mac/Vigie.app" "$HOME/Applications/Vigie.app"
  open "$DEST/mac/Vigie.app" || true
fi
say ""
say "Vigie est installé. Son accueil vient de s'ouvrir ; ensuite il vit dans la barre des menus (les jumelles)."
say "Mettre à jour : relance la même commande. Tout retirer : $DEST/scripts/uninstall.sh"
