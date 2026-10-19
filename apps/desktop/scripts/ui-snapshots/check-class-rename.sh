#!/bin/bash
# Acceptance for renaming zcode- classes / the "zcode" layout value to serika.
# usage: check-class-rename.sh BEFORE_DIR AFTER_DIR BASE_REV
#   BEFORE_DIR: snapshots recorded at BASE_REV; AFTER_DIR: snapshots after the rename.
# Mapping (same as the rename): serika-zcode-shell -> serika-shell; zcode- -> serika-
# (except the preview fixture thread ID zcode-preview-plan, shown truncated as zcode-pr…); "zcode" -> "serika".
# Passes only if all hold:
#   A. Every one of the 138 files (127 HTML + 11 calls-*.txt), mapped, is byte-identical.
#   B. The 11 calls-*.txt files are byte-identical without mapping.
#   C. Every renderer CSS file at BASE_REV, mapped, is byte-identical to the working tree
#      (same rules, selectors and values; nothing added or removed).
set -u
B=$1; A=$2; REV=$3
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
# The fixture thread ID also appears truncated in the page as "zcode-pr…"; it is kept too.
map() { sed -E -e 's/serika-zcode-shell/serika-shell/g' -e 's/zcode-pr(eview-plan|…)/@@KEEP\1@@/g' -e 's/zcode-/serika-/g' \
  -e 's/@@KEEP([^@]*)@@/zcode-pr\1/g' -e 's/"zcode"/"serika"/g'; }
html=0; calls=0; same=0; raw_differ=0; calls_diff=0; fail=0
for f in "$B"/*.html "$B"/calls-*.txt; do
  name=$(basename "$f"); new="$A/$name"
  [ -e "$new" ] || { echo "MISSING $name"; fail=1; continue; }
  if [[ $name == calls-* ]]; then calls=$((calls+1)); cmp -s "$f" "$new" || { calls_diff=$((calls_diff+1)); echo "B: CALLS DIFF $name"; }
  else html=$((html+1)); fi
  cmp -s "$f" "$new" || raw_differ=$((raw_differ+1))
  map < "$f" | cmp -s - "$new" && same=$((same+1)) || echo "A: NOT IDENTICAL AFTER MAPPING $name"
done
nb=$(ls "$B" | grep -cE '\.html$|^calls-'); na=$(ls "$A" | grep -cE '\.html$|^calls-')
[ "$nb" -eq "$na" ] && [ "$html" -eq 127 ] && [ "$calls" -eq 11 ] || { echo "UNEXPECTED FILE COUNT before=$nb after=$na html=$html calls=$calls"; fail=1; }
css=0; css_same=0
for f in $(git -C "$ROOT" ls-tree -r --name-only "$REV" -- apps/desktop/src/renderer | grep '\.css$'); do
  css=$((css+1))
  [ -e "$ROOT/$f" ] || { echo "C: CSS FILE GONE $f"; continue; }
  git -C "$ROOT" show "$REV:$f" | map | cmp -s - "$ROOT/$f" && css_same=$((css_same+1)) || echo "C: CSS DIFF $f"
done
now=$(git -C "$ROOT" ls-files -- apps/desktop/src/renderer | grep -c '\.css$')
[ "$now" -eq "$css" ] || { echo "C: CSS FILE COUNT $css vs $now"; fail=1; }
a=FAIL; [ "$same" -eq 138 ] && a=PASS
b=FAIL; [ "$calls_diff" -eq 0 ] && b=PASS
c=FAIL; [ "$css_same" -eq "$css" ] && [ "$css" -gt 0 ] && c=PASS
echo "raw differing files=$raw_differ (expected: the HTML files that carry zcode- classes)"
echo "A: identical after mapping=$same/138 -> $a"
echo "B: calls diffs=$calls_diff/$calls -> $b"
echo "C: CSS identical after mapping=$css_same/$css -> $c"
[ $fail -eq 0 ] && [ $a = PASS ] && [ $b = PASS ] && [ $c = PASS ] && { echo "RESULT PASS"; exit 0; }
echo "RESULT FAIL"; exit 1
