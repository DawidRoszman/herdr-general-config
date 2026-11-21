set -e
DIR="$HOME/.herdr/browser"
mkdir -p "$DIR"
printf '%s\n' "$1" > "$DIR/launch.sh"
cat > "$DIR/mcp.sh" <<'MCP'
sh "$HOME/.herdr/browser/launch.sh" >/dev/null || exit 1
exec npx -y chrome-devtools-mcp@latest --browserUrl "http://127.0.0.1:${HERDR_BROWSER_PORT:-9333}" --usageStatistics=false --performanceCrux=false
MCP
chmod +x "$DIR/mcp.sh"
done_for=""
if command -v claude >/dev/null 2>&1; then
  for config in "" "$HOME"/.claude-*/; do
    [ -n "$config" ] && [ ! -f "$config/.claude.json" ] && continue
    config=${config%/}
    if [ -n "$config" ]; then export CLAUDE_CONFIG_DIR="$config"; else unset CLAUDE_CONFIG_DIR; fi
    claude mcp remove --scope user herdr-browser >/dev/null 2>&1 || true
    claude mcp add --scope user herdr-browser -- "$DIR/mcp.sh" >/dev/null
    done_for="$done_for Claude(${config:-~/.claude})"
  done
fi
if command -v codex >/dev/null 2>&1; then
  codex mcp remove herdr-browser >/dev/null 2>&1 || true
  codex mcp add herdr-browser -- "$DIR/mcp.sh" >/dev/null
  done_for="$done_for Codex"
fi
echo "herdr-browser set up for:${done_for:- no agents found (install Claude Code or Codex)}"
