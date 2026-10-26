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
# Un clone git (installation depuis les sources) se met à jour avec git pull, jamais par ici.
if [ -e "$DEST/.git" ]; then printf '\n%s\n' "$DEST est un clone git : mets-le à jour avec git pull." >&2; exit 1; fi

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

# 2. Téléchargement et vérification. curl ne pose pas d'attribut de quarantaine : Gatekeeper ne regarderait pas
#    l'app tout seul. On vérifie donc soi-même qu'elle est signée par l'équipe de Vigie et notarisée par Apple, et on
#    n'installe que le moteur scellé dans cette app (couvert par sa signature), jamais un fichier de l'archive à part.
TEAM_ID="CQ43U6XX4Z"
TMP="$(mktemp -d)"
trap 'find "$TMP" -delete 2>/dev/null || true' EXIT
say "… téléchargement de Vigie"
curl -fsSL "$URL" -o "$TMP/vigie.tar.gz" || stop "Téléchargement impossible ($URL)."
mkdir -p "$TMP/x"
tar -xpzf "$TMP/vigie.tar.gz" -C "$TMP/x" || stop "Archive illisible."
NEW_APP="$TMP/x/mac/Vigie.app"
ENGINE="$NEW_APP/Contents/Resources/engine"
[ -d "$NEW_APP" ] && [ -f "$ENGINE/scripts/bootstrap.sh" ] || stop "Archive incomplète."
codesign --verify --deep --strict "$NEW_APP" 2>/dev/null || stop "La signature de l'app est invalide : installation arrêtée."
SIG="$(codesign -dv --verbose=2 "$NEW_APP" 2>&1 || true)"
printf '%s\n' "$SIG" | grep -qx "TeamIdentifier=$TEAM_ID" && printf '%s\n' "$SIG" | grep -q '^Authority=Developer ID Application: ' \
  || stop "L'app n'est pas signée par l'équipe de Vigie : installation arrêtée."
spctl --assess --type execute "$NEW_APP" 2>/dev/null || stop "L'app est refusée par Gatekeeper : installation arrêtée."
say "✓ App signée par l'équipe de Vigie et notarisée par Apple"

# 3. Node.js, app, moteur, hooks, lancement au démarrage
VIGIE_HOME="$DEST" VIGIE_NEW_APP="$NEW_APP" bash "$ENGINE/scripts/bootstrap.sh"

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
