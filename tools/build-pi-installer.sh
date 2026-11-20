#!/usr/bin/env bash
# Builds dist/brewie-pi-install.sh: the Pi installer with the whole app embedded.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p 'require("./package.json").version')
mkdir -p dist
STAGE=$(mktemp -d); mkdir -p "$STAGE/brewie-web"
cp -r package.json README.md PROTOCOL.md src public "$STAGE/brewie-web/"
OUT=dist/brewie-pi-install.sh
sed "s/__VERSION__/$VER/" tools/pi-installer.template.sh > "$OUT"
tar -C "$STAGE" --owner=0 --group=0 -czf - brewie-web | base64 -w 76 >> "$OUT"
chmod +x "$OUT"; rm -rf "$STAGE"
echo "Built $OUT (Brewie Web $VER, $(du -h "$OUT" | cut -f1))"
