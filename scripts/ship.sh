#!/usr/bin/env bash
#
# ship — branch → verify → commit → push → open PR (self-assigned) → [optional] merge → sync main
#
# The merge step is OPT-IN: by default it asks. Keep answering "N" to pile more commits onto the
# same PR; answer "y" on the final run to squash-merge, delete the branch, and sync main.
#
# Usage:
#   pnpm ship "feat(core): add X"             # commit + push + PR, then ASK whether to merge
#   MERGE=1 pnpm ship "feat(core): add X"     # …and merge immediately (no prompt)
#   MERGE=0 pnpm ship "wip: more work"        # …and never merge (keep the PR open for more commits)
#   pnpm ship "fix: y" fix/my-branch          # explicit branch name (2nd arg)
#   DESC="$(pbpaste)" pnpm ship "feat: x"     # use the clipboard as the PR description
#
set -euo pipefail

DEFAULT_BRANCH="main"

# ── pretty output ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
  RED=$'\033[31m'; GRN=$'\033[32m'
else
  B=''; D=''; R=''; RED=''; GRN=''
fi
sep()  { printf '%s\n' "${D}──────────────────────────────────────────────${R}"; }
step() { printf '\n'; sep; printf '%s  %s%s%s\n' "$1" "$B" "$2" "$R"; }  # $1=symbol  $2=label
die()  { printf '\n❌  %s%s%s\n' "$RED" "$1" "$R" >&2; exit 1; }

# ── guards ────────────────────────────────────────────────────────────────
MSG="${1:-}"
[[ -n "$MSG" ]] || die "commit message required — e.g. pnpm ship \"feat(core): summary\""
[[ -n "$(git status --porcelain)" ]] || die "working tree is clean — nothing to commit"

CURRENT="$(git rev-parse --abbrev-ref HEAD)"

# ── decide the branch: explicit arg > current feature branch > derive from message ──
if [[ -n "${2:-}" ]]; then
  BRANCH="$2"
elif [[ "$CURRENT" != "$DEFAULT_BRANCH" ]]; then
  BRANCH="$CURRENT"
else
  # Collapse to a single line first, so an accidental newline in the message (e.g. a wrapped
  # paste) can never produce an invalid branch name.
  SUBJECT="$(printf '%s' "$MSG" | tr '\n' ' ')"
  TYPE="$(printf '%s' "$SUBJECT" | sed -E 's/^([a-z]+).*/\1/')"
  SLUG="$(printf '%s' "${SUBJECT#*: }" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40)"
  BRANCH="${TYPE:-work}/${SLUG:-change}"
fi

if [[ "$CURRENT" != "$BRANCH" ]]; then
  step "🌿" "branch → $BRANCH"
  git checkout -b "$BRANCH"
fi

step "🔍" "verify · format · typecheck · test · build (turbo)"
pnpm run format
pnpm run check

step "📝" "commit → $MSG"
git add -A
git commit -m "$MSG"

step "⬆️ " "push → origin/$BRANCH"
git push -u origin "$BRANCH"

step "🔀" "open PR (self-assigned to @me)"
if ! gh pr view >/dev/null 2>&1; then
  if [[ -n "${DESC:-}" ]]; then
    gh pr create --base "$DEFAULT_BRANCH" --assignee @me --title "$MSG" --body "$DESC"
  else
    gh pr create --base "$DEFAULT_BRANCH" --assignee @me --fill
  fi
fi

# ── decide whether to merge now (MERGE env overrides the prompt) ───────────
case "${MERGE:-}" in
  1|y|Y|yes|YES) DECISION="yes" ;;
  0|n|N|no|NO)   DECISION="no"  ;;
  *)
    printf '\n'; sep
    printf '❓  %sMerge this PR now?%s %s(or add more commits with another `pnpm ship` first)%s [y/N] ' \
      "$B" "$R" "$D" "$R"
    read -r ANS </dev/tty || ANS=""
    case "$ANS" in y|Y|yes|YES) DECISION="yes" ;; *) DECISION="no" ;; esac
    ;;
esac

if [[ "$DECISION" != "yes" ]]; then
  URL="$(gh pr view --json url --jq .url 2>/dev/null || true)"
  step "✋" "PR left open — add more via \`pnpm ship \"…\"\`, then answer y to merge"
  [[ -n "$URL" ]] && printf '   %s%s%s\n' "$D" "$URL" "$R"
  exit 0
fi

# GitHub needs a moment to register the check run — poll until it appears, then watch it.
step "⏳" "waiting for CI to register…"
for _ in $(seq 1 20); do
  if gh pr checks 2>/dev/null | grep -q .; then break; fi
  sleep 3
done

step "🟢" "waiting for CI to pass…"
gh pr checks --watch

step "🔗" "squash-merge + delete branch"
gh pr merge --squash --delete-branch

step "🔄" "sync local $DEFAULT_BRANCH"
git checkout "$DEFAULT_BRANCH"
git pull --ff-only

printf '\n'; sep
printf '🎉  %s%sshipped:%s %s\n' "$GRN" "$B" "$R" "$MSG"
