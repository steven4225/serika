#!/bin/bash
# Acceptance for the zcode-preview -> shell-preview entry rename.
# usage: check-entry-rename.sh BEFORE_DIR AFTER_DIR
#   BEFORE_DIR: snapshots recorded before the rename (file names contain zcode_preview_html)
#   AFTER_DIR:  snapshots recorded after the rename (file names contain shell_preview_html)
# Passes only if all three conditions hold:
#   A. Every differing line (HTML split into one tag per line) matches
#      ^[<>] <script type="module" src="\./src/(zcode|shell)-preview\.tsx">
#      and exactly 51 HTML files differ.
#   B. After mapping that one line back to the old name, all 138 files
#      (127 HTML + 11 calls-*.txt) are byte-identical.
#   C. The 11 calls-*.txt files have zero differences.
set -u
B=$1; A=$2
ENTRY='^[<>] <script type="module" src="\./src/(zcode|shell)-preview\.tsx">'
EXPECT_DIFF=51; EXPECT_HTML=127; EXPECT_CALLS=11
tags() { sed 's/></>\n</g' "$1"; }
fail=0; html=0; calls=0; differ=0; bad_lines=0; identical=0; calls_diff=0
for f in "$B"/*.html "$B"/calls-*.txt; do
  [ -e "$f" ] || continue
  name=$(basename "$f"); new="$A/${name/zcode_preview_html/shell_preview_html}"
  if [ ! -e "$new" ]; then echo "MISSING $(basename "$new")"; fail=1; continue; fi
  if [[ $name == calls-* ]]; then
    calls=$((calls+1))
    cmp -s "$f" "$new" || { calls_diff=$((calls_diff+1)); echo "C: CALLS DIFF $name"; }
  else
    html=$((html+1))
    if ! cmp -s "$f" "$new"; then
      differ=$((differ+1))
      n=$(diff <(tags "$f") <(tags "$new") | grep -E '^[<>] ' | grep -cvE "$ENTRY")
      [ "$n" -eq 0 ] || { bad_lines=$((bad_lines+n)); echo "A: OTHER LINES $name ($n)"; }
    fi
  fi
  sed 's#<script type="module" src="\./src/shell-preview\.tsx">#<script type="module" src="./src/zcode-preview.tsx">#g' "$new" | cmp -s - "$f" \
    && identical=$((identical+1)) || echo "B: NOT IDENTICAL AFTER MAPPING $name"
done
nb=$(ls "$B" | grep -cE '\.html$|^calls-'); na=$(ls "$A" | grep -cE '\.html$|^calls-')
[ "$nb" -eq "$na" ] || { echo "COUNT MISMATCH $nb vs $na"; fail=1; }
[ "$html" -eq $EXPECT_HTML ] && [ "$calls" -eq $EXPECT_CALLS ] || { echo "UNEXPECTED FILE COUNT html=$html calls=$calls"; fail=1; }
a=FAIL; [ "$bad_lines" -eq 0 ] && [ "$differ" -eq $EXPECT_DIFF ] && a=PASS
b=FAIL; [ "$identical" -eq $((EXPECT_HTML+EXPECT_CALLS)) ] && b=PASS
c=FAIL; [ "$calls_diff" -eq 0 ] && c=PASS
echo "A: differing html=$differ (expect $EXPECT_DIFF), other lines=$bad_lines -> $a"
echo "B: identical after mapping=$identical/$((EXPECT_HTML+EXPECT_CALLS)) -> $b"
echo "C: calls diffs=$calls_diff/$calls -> $c"
[ $fail -eq 0 ] && [ $a = PASS ] && [ $b = PASS ] && [ $c = PASS ] && { echo "RESULT PASS"; exit 0; }
echo "RESULT FAIL"; exit 1
