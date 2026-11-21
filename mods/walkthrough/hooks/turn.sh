#!/bin/sh

KEEP=20
MAX_BYTES=1048576

base="${HOME}/.herdr/walkthrough/turns"

field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"\\\\]*\)\".*/\1/p" "$2" | head -n 1
}

snapshot() {
  turn=$1 index=$2 list=$3
  if [ ! -f "$index" ]; then
    real=$(git rev-parse --path-format=absolute --git-path index) || return 1
    [ -f "$real" ] && cp -p "$real" "$index"
  fi
  big=$(git -c core.quotePath=false ls-files --others --exclude-standard -z \
    | xargs -0 sh -c '[ $# -gt 0 ] && find "$@" -prune -type f -size +'"$MAX_BYTES"'c' sh 2>/dev/null)
  printf '%s\n' "$big" | grep -v '^$' > "$list"
  set -- .
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    set -- "$@" ":(exclude,literal)$path"
    GIT_INDEX_FILE="$index" git update-index --force-remove -- "$path" 2>/dev/null
  done <<EOF
$big
EOF
  add() {
    GIT_INDEX_FILE="$index" GIT_OBJECT_DIRECTORY="$turn/objects" \
      git -c core.fsmonitor=false -c gc.auto=0 -c maintenance.auto=false add -A -- "$@" &&
    GIT_INDEX_FILE="$index" GIT_OBJECT_DIRECTORY="$turn/objects" git write-tree --missing-ok
  }
  add "$@" || { rm -f "$index"; add "$@"; }
}

put() {
  printf '%s' "$2" > "$1.tmp" && mv "$1.tmp" "$1"
}

turns() {
  ls -1 "$repo" 2>/dev/null | grep -E '^[0-9]+-[0-9]+$' | sort -r
}

main() {
  event=$1
  case "$event" in start|stop) ;; *) return 0 ;; esac
  mkdir -p "$base" || return 0
  input="$base/input.$$"
  cat > "$input" || return 0

  cwd=$(field cwd "$input")
  [ -n "$cwd" ] && cd "$cwd" 2>/dev/null
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  cd "$top" || return 0
  key=$(printf '%s' "$top" | git hash-object --stdin | cut -c1-16) || return 0
  repo="$base/$key"
  mkdir -p "$repo" || return 0
  [ -f "$repo/top" ] || put "$repo/top" "$top"
  session=$(field session_id "$input")
  now=$(date +%s)

  if [ "$event" = start ]; then
    grep -q '"prompt"[[:space:]]*:[[:space:]]*"<task-notification>' "$input" && return 0
    turn="$repo/$now-$(printf '%06d' $$)"
    mkdir -p "$turn/objects" || return 0
    mv "$input" "$turn/start.json"
    for old in $(turns); do
      [ "$repo/$old" = "$turn" ] && continue
      if [ -f "$repo/$old/end.meta" ] || { [ -n "$session" ] && grep -qx "session=$session" "$repo/$old/start.meta"; }; then
        rm -f "$repo/$old/index"
      fi
    done
    tree=$(snapshot "$turn" "$turn/index" "$turn/start.big") || { rm -rf "$turn/objects" "$turn/index"; return 0; }
    put "$turn/start.meta" "tree=$tree
started=$now
session=$session
terminal=${HC_TERMINAL_ID:-}
"
    turns | tail -n +$((KEEP + 1)) | while IFS= read -r old; do rm -rf "${repo:?}/$old"; done
    return 0
  fi

  turn=
  for name in $(turns); do
    if [ -z "$session" ] || grep -qx "session=$session" "$repo/$name/start.meta" || [ "$(field session_id "$repo/$name/start.json")" = "$session" ]; then
      turn="$repo/$name"
      break
    fi
  done
  [ -n "$turn" ] && [ -f "$turn/start.meta" ] || return 0
  tree=$(snapshot "$turn" "$turn/index" "$turn/end.big") || return 0
  mv "$input" "$turn/end.json"
  put "$turn/end.meta" "tree=$tree
ended=$now
"
}

main "$@" >/dev/null 2>&1
rm -f "${HOME}/.herdr/walkthrough/turns/input.$$" 2>/dev/null
exit 0
