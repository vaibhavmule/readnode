#!/bin/sh
# Render og.html to public/og.png (1200x630) with headless Chrome.
cd "$(dirname "$0")"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1200,630 --screenshot="$PWD/../public/og.png" "file://$PWD/og.html"
