#!/bin/sh
# Rasterise og/card.html to og.png at exactly 1200x630, which is what Open Graph
# and Twitter want. Headless Chrome is the only dependency, and it is the one
# renderer guaranteed to agree with what a browser would draw.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
"$chrome" --headless --disable-gpu --hide-scrollbars \
  --screenshot="$here/../public/og.png" --window-size=1200,630 \
  --default-background-color=00000000 \
  "file://$here/card.html" >/dev/null 2>&1
echo "wrote $(cd "$here/../public" && pwd)/og.png"
