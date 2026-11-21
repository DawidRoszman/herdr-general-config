#!/bin/sh
set -eu
BASE="$HOME/.herdr/mr-test"
PROJECT="$BASE/AcmeShop"
MR="$(cd "$(dirname "$0")" && pwd)/mr.py"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

if [ "${1:-}" = rm ]; then
  for task in "$HOME/.herdr/projects/AcmeShop"/*/; do
    [ -f "$task/.mr-task.json" ] && python3 "$MR" rm --force --task "$task" || true
  done
  rm -rf "$BASE" "$HOME/.herdr/projects/AcmeShop"
  python3 - <<'EOF'
import json, pathlib
registry = pathlib.Path.home() / ".config" / "mr" / "projects.json"
if registry.exists():
    data = json.loads(registry.read_text())
    data["projects"] = [p for p in data["projects"] if pathlib.Path(p).exists()]
    registry.write_text(json.dumps(data, indent=2) + "\n")
EOF
  echo "removed $PROJECT"
  exit 0
fi

[ -e "$PROJECT" ] && { echo "$PROJECT exists; run '$0 rm' first" >&2; exit 1; }
mkdir -p "$BASE/origin" "$PROJECT"
for spec in acme-shop-backend:develop acme-shop-portal:develop helper-scripts:main; do
  name=${spec%%:*}; base=${spec##*:}
  seed="$BASE/seed/$name"
  git init -q -b "$base" "$seed"
  printf '# %s\n' "$name" > "$seed/README.md"
  mkdir -p "$seed/src" && printf 'print("%s")\n' "$name" > "$seed/src/main.py"
  git -C "$seed" add . && git -C "$seed" commit -qm "chore: initial commit"
  git clone -q --bare "$seed" "$BASE/origin/$name.git"
  git clone -q "$BASE/origin/$name.git" "$PROJECT/$name"
done
rm -rf "$BASE/seed"
python3 "$MR" init "$PROJECT"

python3 "$MR" new feat/SHOP-130-checkout-flow backend portal --project "$PROJECT" >/dev/null
task="$HOME/.herdr/projects/AcmeShop/feat-SHOP-130-checkout-flow"
printf 'def checkout(): ...\n' > "$task/acme-shop-backend/src/checkout.py"
git -C "$task/acme-shop-backend" add . && git -C "$task/acme-shop-backend" commit -qm "feat(SHOP-130): checkout endpoint"
printf 'draft\n' > "$task/acme-shop-portal/src/checkout.tsx"
git -C "$PROJECT/helper-scripts" push -q origin main:test/SHOP-130-e2e main:feature-helpers-wishlist
python3 "$MR" new fix/SHOP-7-typo-in-readme helper --project "$PROJECT" >/dev/null
python3 "$MR" new feat/SHOP-132-cart-ui backend --on feat/SHOP-130-checkout-flow --project "$PROJECT" >/dev/null
echo "$PROJECT: ready (tasks under $HOME/.herdr/projects/AcmeShop)"
