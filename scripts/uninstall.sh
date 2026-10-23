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
PORT="${VIGIE_PORT:-4777}"

# MCP passés par Vigie : rebranchés en direct dans chaque compte (le moteur tourne encore), sinon ils viseraient
# un Vigie arrêté. Leurs jetons, gardés par Vigie, sont oubliés : chaque compte se reconnectera au service.
if [ -z "$DRY" ]; then
  "$NODE" --input-type=module -e '
const base = `http://127.0.0.1:${process.argv[1]}/api/v2`;
let names = [];
try { names = Object.keys((await (await fetch(`${base}/mcp`)).json()).gateway || {}); } catch { process.exit(0); }
for (const name of names) {
  const r = await fetch(`${base}/gateway`, { method: "POST", headers: { "content-type": "application/json", "x-vigie": "1" }, body: JSON.stringify({ action: "restore", name }) })
    .then((x) => x.json()).catch((e) => ({ error: String(e) }));
  console.log(r.ok ? `MCP ${name} : rebranché en direct` : `MCP ${name} : ${r.error}`);
}
' "$PORT" || echo "MCP : passerelle non vérifiée."
fi

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
# App glissée dans Applications (data/app.path) : elle est quittée et ne s'ouvre plus à la connexion ; avec --tout,
# elle part aussi.
STANDALONE_APP=""
[ -f "$ROOT/data/app.path" ] && STANDALONE_APP="$(cat "$ROOT/data/app.path")"
if [ -n "$STANDALONE_APP" ]; then
  run pkill -x Vigie 2>/dev/null || true
  [ -x "$STANDALONE_APP/Contents/MacOS/Vigie" ] && { run "$STANDALONE_APP/Contents/MacOS/Vigie" --desinscrire || true; }
  case "$STANDALONE_APP" in
    */Vigie.app) if [ "${1:-}" = "--tout" ] && [ -d "$STANDALONE_APP" ]; then run rm -rf "$STANDALONE_APP"; echo "App $STANDALONE_APP retirée."; fi ;;
  esac
fi
# --tout : le dossier d'installation (~/.vigie) part aussi, réglages et historique compris, avec ce que macOS garde
# pour l'app (préférences, dont l'accueil déjà vu ; autorisations ; jetons des MCP ; clé du coffre des connexions,
# dont les copies chiffrées sont dans ~/.vigie/data/coffre ; journal d'installation).
# Les comptes Claude (~/.claude-comptes et leurs connexions) ne sont jamais touchés.
if [ "${1:-}" = "--tout" ]; then
  run defaults delete io.github.paulmailhes.vigie 2>/dev/null || true
  run tccutil reset All io.github.paulmailhes.vigie >/dev/null 2>&1 || true
  if [ -z "$DRY" ]; then
    while security delete-generic-password -s "Vigie MCP" >/dev/null 2>&1; do :; done
    while security delete-generic-password -s "Vigie connexions" >/dev/null 2>&1; do :; done
  fi
  run rm -f "$HOME/Library/Logs/Vigie-installation.log"
  case "$ROOT" in
    "$HOME/.vigie") run rm -rf "$ROOT"; echo "Dossier $ROOT effacé." ;;
    *) echo "--tout n'efface que ~/.vigie (ici : $ROOT, gardé)." ;;
  esac
fi
echo "Vigie est retirée. Les conversations ouvertes reprennent le fonctionnement normal tout de suite."
