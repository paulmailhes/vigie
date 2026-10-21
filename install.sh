#!/bin/bash
# Vigie : installation en une commande (le plus simple reste l'app : télécharge Vigie.dmg et glisse-la dans
# Applications ; cette commande sert aussi aux mises à jour).
#
#   curl -fsSL https://raw.githubusercontent.com/paulmailhes/vigie/main/install.sh | bash
#
# Ce que fait ce script :
#   1. vérifie le Mac (macOS 26 ou plus récent) ;
#   2. télécharge la dernière version de Vigie (moteur + app signée) ;
#   3. passe la main à scripts/bootstrap.sh : Node.js (installé dans ~/.vigie/node s'il manque), moteur dans ~/.vigie,
#      app remplacée là où elle est (Applications, ou ~/.vigie/mac), hook dans Claude Code et Codex, lancement au
#      démarrage ;
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
say "✓ macOS $(sw_vers -productVersion)"
if [ ! -d "$HOME/.claude" ]; then
  say "! Claude Code ne semble pas encore installé (pas de dossier ~/.claude). Vigie s'installe quand même :"
  say "  il veillera dès que tu utiliseras Claude Code."
fi

# 2. Téléchargement (curl ne pose pas d'attribut de quarantaine ; l'app est de toute façon signée et notarisée)
TMP="$(mktemp -d)"
trap 'find "$TMP" -delete 2>/dev/null || true' EXIT
say "… téléchargement de Vigie"
curl -fsSL "$URL" -o "$TMP/vigie.tar.gz" || stop "Téléchargement impossible ($URL)."
mkdir -p "$TMP/x"
tar -xzf "$TMP/vigie.tar.gz" -C "$TMP/x" || stop "Archive illisible."
[ -f "$TMP/x/server.mjs" ] && [ -d "$TMP/x/mac/Vigie.app" ] || stop "Archive incomplète."

# 3. Node.js, moteur, app, hooks, lancement au démarrage
if [ -x "$TMP/x/scripts/bootstrap.sh" ]; then
  VIGIE_HOME="$DEST" "$TMP/x/scripts/bootstrap.sh"
else
  # archive d'avant bootstrap.sh (0.2.13 et avant) : on ne sait plus l'installer d'ici
  stop "Archive trop ancienne pour cet installeur."
fi

# 4. L'app (VIGIE_DRY_RUN : essai, rien n'est relié ni ouvert ; VIGIE_UPDATE : mise à jour lancée par Vigie, l'app
#    est relancée par l'installation, on ne lui fait pas prendre le premier plan)
APP="$DEST/mac/Vigie.app"
[ -f "$DEST/data/app.path" ] && APP="$(cat "$DEST/data/app.path")"
if [ -z "${VIGIE_DRY_RUN:-}" ]; then
  if [ "$APP" = "$DEST/mac/Vigie.app" ]; then
    mkdir -p "$HOME/Applications"
    ln -sfn "$APP" "$HOME/Applications/Vigie.app"
  fi
  [ -n "${VIGIE_UPDATE:-}" ] || open "$APP" || true
fi
say ""
say "Vigie est installé. Son accueil vient de s'ouvrir ; ensuite il vit dans la barre des menus (les jumelles)."
say "Mettre à jour : relance la même commande. Tout retirer : $DEST/scripts/uninstall.sh"
