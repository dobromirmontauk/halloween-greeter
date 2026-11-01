#!/bin/bash
# Screenshots of the operator page against scripts/ui-mock.mjs (synthetic data). Usage: node scripts/ui-mock.mjs 3939 & bash scripts/ui-shots.sh
cd "$(dirname "$0")/.."
CH="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROF="$(mktemp -d)"
shot(){ "$CH" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$PROF" --window-size="$2" --virtual-time-budget=5000 --screenshot="evidence/ui-stacked-$1.png" "http://127.0.0.1:3939/${3:-}" >/dev/null 2>&1; }
for s in OFF WATCHING LIVE_ACTIVE CLOSING DEBUG_SPEAKING ERROR CAPTURING; do
  curl -s "localhost:3939/__scenario/$s" >/dev/null
  shot "$(echo "$s" | tr 'A-Z' 'a-z')" 1280,1000
done
curl -s localhost:3939/__scenario/LIVE_ACTIVE >/dev/null
shot phone 390,1800 __phone
ls -la evidence | grep stacked
