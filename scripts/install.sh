#!/bin/bash
# Installe Vigie : hook dans Claude Code, moteur (serveur local) et app Mac lancés au démarrage.
# Relançable sans risque. Pour tout retirer : scripts/uninstall.sh
# VIGIE_DRY_RUN=1 : écrit les fichiers (dans HOME, VIGIE_LAUNCH_AGENTS) mais ne lance, n'arrête et ne
# compile rien ; les commandes sont seulement affichées (tests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Node.js : VIGIE_NODE (donné par install.sh), sinon le PATH, sinon les emplacements habituels.
NODE="${VIGIE_NODE:-}"
for c in "$NODE" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$ROOT/node/bin/node"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
[ -x "$NODE" ] || { echo "Node.js introuvable : installe-le (https://nodejs.org), puis relance." >&2; exit 1; }
LA="${VIGIE_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
PORT="${VIGIE_PORT:-4777}"
GUI="gui/$(id -u)"
DRY="${VIGIE_DRY_RUN:-}"
# L'app : celle glissée dans Applications (VIGIE_APP, donnée par bootstrap.sh), sinon celle de ce dossier (Terminal).
APP="${VIGIE_APP:-$ROOT/mac/Vigie.app}"
# Glissée dans Applications : elle s'ouvre à la connexion par elle-même (élément d'ouverture de macOS), pas par
# l'agent « menu » de launchd, qui en lancerait une seconde copie.
case "$APP" in "$ROOT"/*) STANDALONE= ;; *) STANDALONE=1 ;; esac
run() { if [ -n "$DRY" ]; then echo "[essai] $*"; else "$@"; fi; }

echo "1/4 Hook dans Claude Code"
VIGIE_NODE="$NODE" "$NODE" "$ROOT/scripts/settings.mjs" install "$@"

echo "2/4 App Vigie"
# Version publiée : l'app est déjà construite (VIGIE_PREBUILT=1). Depuis les sources : mac/build-app.sh la
# construit (il faut les outils de développement d'Apple : xcode-select --install). S'il échoue, l'ancienne app reste.
if [ -n "${VIGIE_PREBUILT:-}" ] && [ -d "$APP" ]; then
  echo "App déjà construite : $APP"
elif ! command -v swift >/dev/null 2>&1; then
  echo "Swift introuvable : l'app n'est pas construite (xcode-select --install, puis relance)."
elif [ -x "$ROOT/mac/build-app.sh" ]; then
  run "$ROOT/mac/build-app.sh" || echo "La construction de l'app a échoué : l'app actuelle est gardée."
else
  echo "mac/build-app.sh introuvable : app non reconstruite."
fi
EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || echo Vigie)"
APP_BIN="$APP/Contents/MacOS/$EXE"

echo "3/4 Lancement au démarrage (launchd)"
mkdir -p "$LA"
[ -n "$DRY" ] || mkdir -p "$ROOT/data"
cat > "$LA/io.github.paulmailhes.vigie.engine.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.paulmailhes.vigie.engine</string>
  <!-- Moteur de Vigie : API locale http://127.0.0.1:$PORT lue par l'app -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- Standard et non Background : au démarrage du Mac, l'indexation finit en ~15 s au lieu de ~1 min. -->
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>$ROOT/data/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/server.log</string>
</dict>
</plist>
PLIST
MENU=1
# où est l'app (mises à jour : bootstrap.sh la remplace là où elle est)
if [ -n "$STANDALONE" ]; then
  [ -n "$DRY" ] || printf '%s\n' "$APP" > "$ROOT/data/app.path"
else
  rm -f "$ROOT/data/app.path"
fi
if [ -n "$STANDALONE" ]; then
  MENU=
  rm -f "$LA/io.github.paulmailhes.vigie.menu.plist"
  echo "App : $APP (elle s'ouvre à la connexion par elle-même)"
elif [ -x "$APP_BIN" ] || [ -n "$DRY" ]; then
  cat > "$LA/io.github.paulmailhes.vigie.menu.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.paulmailhes.vigie.menu</string>
  <!-- App Vigie (fenêtre + icône dans la barre des menus). « Quitter » la ferme jusqu'à la prochaine session. -->
  <key>ProgramArguments</key>
  <array>
    <string>$APP_BIN</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
else
  MENU=
  echo "Pas d'app construite ($APP_BIN) : l'app ne sera pas lancée au démarrage."
fi

for label in io.github.paulmailhes.vigie.engine io.github.paulmailhes.vigie.menu; do
  run launchctl bootout "$GUI/$label" 2>/dev/null || true
done
# Un serveur lancé à la main depuis ce dossier occuperait encore le port : on n'arrête que lui.
for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
  case "$cmd" in
    *"$ROOT/server.mjs"*) run kill "$pid" ;;
    *server.mjs*) if [ "$cwd" = "$ROOT" ]; then run kill "$pid"; fi ;;
  esac
done
run launchctl bootstrap "$GUI" "$LA/io.github.paulmailhes.vigie.engine.plist"
if [ -n "$MENU" ]; then run launchctl bootstrap "$GUI" "$LA/io.github.paulmailhes.vigie.menu.plist"; fi
# Mise à jour d'une app glissée dans Applications : elle vient d'être remplacée, on la relance au second plan.
if [ -n "$STANDALONE" ] && [ -n "${VIGIE_UPDATE:-}" ] && [ -z "$DRY" ]; then
  pkill -x Vigie 2>/dev/null || true
  sleep 1
  open -g "$APP" || true
fi

echo "4/4 Vérification"
if [ -n "$DRY" ]; then echo "[essai] terminé"; exit 0; fi
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/v2/health" >/dev/null && break; sleep 1; done
if curl -sf "http://127.0.0.1:$PORT/api/v2/health" >/dev/null; then
  echo "Vigie tourne. Ouvre l'app Vigie (icône dans la barre des menus)."
else
  echo "Le moteur ne répond pas, voir $ROOT/data/server.log"; exit 1
fi
