#!/usr/bin/env bash
#
# ship — one command for the whole increment flow:
#   branch → verify → commit → push → open PR → wait for CI → squash-merge → delete branch → sync main
#
# Usage:
#   pnpm ship "feat(core): add ConnectionManager"            # branch auto-derived from the message
#   pnpm ship "fix(core): guard reconnect" fix/reconnect     # explicit branch name
#
set -euo pipefail

DEFAULT_BRANCH="main"

MSG="${1:-}"
if [[ -z "$MSG" ]]; then
  echo "✗ commit message required — e.g. pnpm ship \"feat(core): summary\"" >&2
  exit 1
fi

# Nothing to ship?
if [[ -z "$(git status --porcelain)" ]]; then
  echo "✗ working tree is clean — nothing to commit" >&2
  exit 1
fi

CURRENT="$(git rev-parse --abbrev-ref HEAD)"

# Decide the branch: explicit arg > current feature branch > derive from message
if [[ -n "${2:-}" ]]; then
  BRANCH="$2"
elif [[ "$CURRENT" != "$DEFAULT_BRANCH" ]]; then
  BRANCH="$CURRENT"
else
  TYPE="$(printf '%s' "$MSG" | sed -E 's/^([a-z]+).*/\1/')"
  SLUG="$(printf '%s' "${MSG#*: }" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40)"
  BRANCH="${TYPE:-work}/${SLUG:-change}"
fi

if [[ "$CURRENT" != "$BRANCH" ]]; then
  echo "▶ branch: $BRANCH"
  git checkout -b "$BRANCH"
fi

echo "▶ verify (format + typecheck + build)"
pnpm -r --if-present check

echo "▶ commit"
git add -A
git commit -m "$MSG"

echo "▶ push"
git push -u origin "$BRANCH"

echo "▶ open PR (if not already open)"
gh pr view >/dev/null 2>&1 || gh pr create --fill --base "$DEFAULT_BRANCH"

echo "▶ wait for CI to pass…"
gh pr checks --watch

echo "▶ squash-merge + delete branch"
gh pr merge --squash --delete-branch

echo "▶ sync local $DEFAULT_BRANCH"
git checkout "$DEFAULT_BRANCH"
git pull --ff-only

echo "✅ shipped: $MSG"
