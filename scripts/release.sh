#!/bin/bash
# Prépare une version publiable : l'app universelle (Apple Silicon + Intel) et l'archive dist/vigie.tar.gz
# que télécharge install.sh. Usage : scripts/release.sh 0.1.0
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:?version, par exemple 0.1.0}"
cd "$ROOT"
echo "1/3 Tests du moteur"
node --test test/ >/dev/null || { echo "Des tests échouent : rien n'est publié." >&2; exit 1; }
echo "2/3 App (universelle)"
VIGIE_UNIVERSAL=1 VIGIE_VERSION="$VERSION" ./mac/build-app.sh >/dev/null
echo "3/3 Archive"
mkdir -p dist
# VERSION : lue par le moteur pour proposer les mises à jour (lib/update.mjs)
echo "$VERSION" > VERSION
tar -czf dist/vigie.tar.gz --exclude '.DS_Store' --exclude 'docs/images' \
  VERSION hook.mjs server.mjs lib bin scripts public docs README.md LICENSE mac/Vigie.app
echo "Prêt : dist/vigie.tar.gz ($(du -h dist/vigie.tar.gz | cut -f1)) — version $VERSION"
