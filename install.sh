#!/bin/bash
# Vigie : installation en une commande.
#
#   curl -fsSL https://raw.githubusercontent.com/paulmailhes/vigie/main/install.sh | bash
#
# Ce que fait ce script :
#   1. vérifie le Mac (macOS 26 ou plus récent) et Node.js (version 20 ou plus récente) ;
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

# Node.js : celui du PATH, sinon les emplacements habituels (Homebrew, Volta, nvm, installeur officiel).
find_node() {
  local c
  for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
           $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1); do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}
NODE="$(find_node || true)"
[ -n "$NODE" ] || stop "Node.js est nécessaire. Installe-le depuis https://nodejs.org (version LTS) ou avec « brew install node », puis relance cette commande."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || stop "Node.js $("$NODE" -v) est trop ancien : il faut la version 20 ou plus récente (https://nodejs.org)."
say "✓ macOS $(sw_vers -productVersion), Node.js $("$NODE" -v)"

if [ ! -d "$HOME/.claude" ]; then
  say "! Claude Code ne semble pas encore installé (pas de dossier ~/.claude). Vigie s'installe quand même :"
  say "  il veillera dès que tu utiliseras Claude Code."
fi

# 2. Téléchargement (curl ne pose pas d'attribut de quarantaine : l'app s'ouvre sans alerte de Gatekeeper)
TMP="$(mktemp -d)"
trap 'find "$TMP" -delete 2>/dev/null || true' EXIT
say "… téléchargement de Vigie"
curl -fsSL "$URL" -o "$TMP/vigie.tar.gz" || stop "Téléchargement impossible ($URL)."
mkdir -p "$TMP/x"
tar -xzf "$TMP/vigie.tar.gz" -C "$TMP/x" || stop "Archive illisible."
[ -f "$TMP/x/server.mjs" ] && [ -d "$TMP/x/mac/Vigie.app" ] || stop "Archive incomplète."

mkdir -p "$DEST"
# Mise à jour : tout est remplacé, sauf data/ (réglages, historique, comptes).
rsync -a --delete --exclude data "$TMP/x/" "$DEST/"
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
