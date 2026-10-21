#!/bin/bash
# Retire Vigie : débranche le hook (Claude Code redevient comme avant), arrête le moteur et l'app.
# Les réglages et l'historique (data/) sont gardés, sauf avec --tout (le dossier de Vigie est alors effacé).
# VIGIE_DRY_RUN=1 : n'arrête rien, affiche seulement.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE=""
for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$ROOT/node/bin/node"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
[ -x "$NODE" ] || { echo "Node.js introuvable : impossible de débrancher le hook proprement." >&2; exit 1; }
LA="${VIGIE_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
GUI="gui/$(id -u)"
DRY="${VIGIE_DRY_RUN:-}"
run() { if [ -n "$DRY" ]; then echo "[essai] $*"; else "$@"; fi; }

"$NODE" "$ROOT/scripts/settings.mjs" uninstall

# Lanceur de comptes (réglage claudeCode.claudeProcessWrapper de VS Code) : retiré aussi, et seulement
# s'il désigne CE dossier. Sinon VS Code continuerait de lancer chaque conversation par ce script, et
# n'en lancerait plus aucune le jour où ce dossier disparaît. Réglages VS Code sauvegardés avant écriture.
"$NODE" --input-type=module -e '
const { pathToFileURL } = await import("node:url");
const { createAccounts } = await import(pathToFileURL(process.argv[1]).href);
const r = createAccounts().wrapper(false);
console.log(r.ok ? `Lanceur de comptes : ${r.message}` : `Lanceur de comptes : ${r.error}`);
' "$ROOT/lib/accounts.mjs" || echo "Lanceur de comptes : réglage VS Code non vérifié, à retirer à la main (claudeCode.claudeProcessWrapper)."

# Un hook encore en attente (garde-fou, question) répondrait après coup : on l'arrête. Arrêté, il ne
# répond rien et la fenêtre normale reste à l'utilisateur. Seuls les hooks de CE dossier sont visés.
for pid in $(pgrep -f "$ROOT/hook.mjs" 2>/dev/null || true); do
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$cmd" in
    *node*" $ROOT/hook.mjs" | *node*" $ROOT/hook.mjs "*) run kill "$pid" ;;
  esac
done

for label in io.github.paulmailhes.vigie.menu io.github.paulmailhes.vigie.engine; do
  run launchctl bootout "$GUI/$label" 2>/dev/null || true
  rm -f "$LA/$label.plist"
done
# Raccourci de l'app dans ~/Applications (posé par install.sh), seulement s'il désigne CE dossier.
if [ -L "$HOME/Applications/Vigie.app" ] && [ "$(readlink "$HOME/Applications/Vigie.app")" = "$ROOT/mac/Vigie.app" ]; then
  run rm -f "$HOME/Applications/Vigie.app"
fi
# --tout : le dossier d'installation (~/.vigie) part aussi, réglages et historique compris.
if [ "${1:-}" = "--tout" ]; then
  case "$ROOT" in
    "$HOME/.vigie") run rm -rf "$ROOT"; echo "Dossier $ROOT effacé." ;;
    *) echo "--tout n'efface que ~/.vigie (ici : $ROOT, gardé)." ;;
  esac
fi
echo "Vigie est retirée. Les conversations ouvertes reprennent le fonctionnement normal tout de suite."
