# Starts the shared headless browser on this machine, unless it already runs, and prints
# {"port", "state": "running" | "started"} or an error. Herdr's browser pane and the agents'
# chrome-devtools-mcp (setup.sh) both attach to it on 127.0.0.1:$PORT.
PORT=${HERDR_BROWSER_PORT:-9333}
DIR="$HOME/.herdr/browser"
alive() { curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }
if alive; then echo "{\"port\":$PORT,\"state\":\"running\"}"; exit 0; fi

# Chrome or Chromium: $HERDR_BROWSER, macOS's Chrome, Playwright's newest Chromium, then PATH.
pick() {
  [ -n "$HERDR_BROWSER" ] && [ -x "$HERDR_BROWSER" ] && { echo "$HERDR_BROWSER"; return; }
  for b in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    [ -x "$b" ] && { echo "$b"; return; }
  done
  for b in $(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome \
      "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium 2>/dev/null | sort -t- -k2 -n -r); do
    [ -x "$b" ] && { echo "$b"; return; }
  done
  for b in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$b" >/dev/null 2>&1 && { command -v "$b"; return; }
  done
}
BIN=$(pick)
if [ -z "$BIN" ]; then echo "No Chrome or Chromium here: install one, or set HERDR_BROWSER." >&2; exit 2; fi
mkdir -p "$DIR/profile"
nohup "$BIN" --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" \
  --user-data-dir="$DIR/profile" --no-first-run --no-default-browser-check --disable-gpu \
  --force-device-scale-factor=2 --window-size=1280,800 about:blank >"$DIR/chrome.log" 2>&1 </dev/null &
for _ in $(seq 1 40); do
  if alive; then echo "{\"port\":$PORT,\"state\":\"started\"}"; exit 0; fi
  sleep 0.25
done
echo "The browser did not start: $(tail -3 "$DIR/chrome.log")" >&2
exit 1
