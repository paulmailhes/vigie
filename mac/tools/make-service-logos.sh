#!/bin/bash
# Télécharge les logos de services depuis Simple Icons (licence CC0) et écrit
# VigieApp/Sources/Vigie/UI/ServiceLogos.swift (SVG embarqués, affichés monochromes).
# Usage : mac/tools/make-service-logos.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/VigieApp/Sources/Vigie/UI/ServiceLogos.swift"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SLUGS="figma webflow notion supabase netlify vercel resend n8n obsidian github gmail googledrive googlecalendar googlesheets claude stripe semrush vimeo paddle"
{
  echo "// Généré par mac/tools/make-service-logos.sh : logos Simple Icons (CC0, https://simpleicons.org)."
  echo "// Ne pas modifier à la main."
  echo "enum ServiceLogos {"
  echo "    static let svg: [String: String] = ["
  for slug in $SLUGS; do
    if curl -fsS -o "$TMP/$slug.svg" "https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/$slug.svg"; then
      body="$(sed -e 's#<title>[^<]*</title>##' -e 's# role="img"##' "$TMP/$slug.svg" | tr -d '\n')"
      case "$body" in *'"#'*) echo "ignoré : $slug" >&2; continue;; esac
      echo "        \"$slug\": #\"$body\"#,"
    else
      echo "absent : $slug" >&2
    fi
  done
  echo "    ]"
  echo "}"
} > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "Écrit : $OUT"
