#!/usr/bin/env bash
# Rollback check for the optional receipt field errorCode (commit 51677be).
# Usage: packages/assistant/scripts/receipt-compat/run.sh [OLD_REV]   (default c465507)
# Builds a temporary detached worktree of OLD_REV (no checkout of main), then:
#   1. new code writes run-1 (TOOL_DENIED + TOOL_EXECUTION_FAILED)
#   2. old code reads it (must not throw)
#   3. new code reads it (deny -> errorCode TOOL_DENIED, other failure -> null)
#   4. old code appends run-2 into the same directory
#   5. new code reads both runs
# Prints every command with its exit code; exits 1 if any step or expectation fails.
set -u
OLD_REV="${1:-c465507}"
ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/packages/assistant/scripts/receipt-compat"
TMP="$(mktemp -d)"
OLD="$TMP/old"
REC="$TMP/rec"
fail=0
cleanup() { git -C "$ROOT" worktree remove --force "$OLD" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
git -C "$ROOT" worktree add -q --detach "$OLD" "$OLD_REV" || exit 1
ln -s "$ROOT/node_modules" "$OLD/node_modules"
ln -s "$ROOT/packages/assistant/node_modules" "$OLD/packages/assistant/node_modules"
mkdir -p "$REC"
echo "new=$(git -C "$ROOT" rev-parse --short HEAD) old=$(git -C "$OLD" rev-parse --short HEAD)"
step() { # step NAME CMD...
  local name="$1"; shift
  echo "\$ $*"
  OUT="$(cd "$ROOT" && "$@" 2>&1)"; local code=$?
  [ -n "$OUT" ] && echo "$OUT"
  echo "[$name] exit=$code"
  [ $code -eq 0 ] || fail=1
}
expect() { # expect NAME SUBSTRING
  if [[ "$OUT" == *"$2"* ]]; then echo "[$1] PASS contains $2"; else echo "[$1] FAIL missing $2"; fail=1; fi
}
TSX="npx --no-install tsx"
step "1 new write" $TSX "$HERE/write.mts" "$ROOT" "$REC"
echo "\$ grep -rho '\"errorCode\":\"[A-Z_]*\"' rec"; grep -rho '"errorCode":"[A-Z_]*"' "$REC"; echo "[1 on disk] exit=$?"
step "2 old read" $TSX "$HERE/read.mts" "$OLD" "$REC"
expect "2 old read" '"runs":1'
step "3 new read" $TSX "$HERE/read.mts" "$ROOT" "$REC"
expect "3 new read" '{"id":"deny","status":"failed","errorCode":"TOOL_DENIED"}'
expect "3 new read" '{"id":"fail","status":"failed","errorCode":null}'
step "4 old write" $TSX "$HERE/write-plain.mts" "$OLD" "$REC"
step "5 new read" $TSX "$HERE/read.mts" "$ROOT" "$REC"
expect "5 new read" '"runs":2'
expect "5 new read" '{"id":"deny","status":"failed","errorCode":"TOOL_DENIED"}'
[ $fail -eq 0 ] && echo "RESULT PASS" || echo "RESULT FAIL"
exit $fail
