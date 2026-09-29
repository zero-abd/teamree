#!/bin/sh
# Rasterise og/card.html to public/og.png at 1200x630 with headless Chrome. Chrome writes the file but can linger
# afterwards, so it runs on a throwaway profile and is killed once the PNG lands (or after 60 s).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
out="$here/../public/og.png"
tmp="$here/og.tmp.png"
profile=$(mktemp -d)
rm -f "$tmp"
"$chrome" --headless=new --no-first-run --disable-gpu --hide-scrollbars --use-mock-keychain \
  --password-store=basic --user-data-dir="$profile" --window-size=1200,630 \
  --screenshot="$tmp" "file://$here/card.html" >/dev/null 2>&1 &
pid=$!
i=0
while [ ! -s "$tmp" ] && [ $i -lt 60 ]; do sleep 1; i=$((i + 1)); done
sleep 1
kill -9 "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
rm -rf "$profile"
[ -s "$tmp" ] || { echo "no screenshot after 60 s" >&2; exit 1; }
mv "$tmp" "$out"
echo "wrote $(cd "$here/../public" && pwd)/og.png"
