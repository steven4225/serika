#!/bin/bash
# Compare two snapshot directories written by states.mjs / flows.mjs.
# usage: compare.sh BEFORE_DIR AFTER_DIR
set -u
n=0; d=0
for f in "$1"/*.html "$1"/calls-*.txt; do
  [ -e "$f" ] || continue
  n=$((n+1))
  cmp -s "$f" "$2/$(basename "$f")" || { d=$((d+1)); echo "DIFF $(basename "$f")"; }
done
before=$(ls "$1" | grep -cE '\.html$|^calls-'); after=$(ls "$2" | grep -cE '\.html$|^calls-')
[ "$before" -eq "$after" ] || echo "COUNT MISMATCH $before vs $after"
echo "compared=$n diffs=$d"
