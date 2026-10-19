#!/bin/bash
# Compare two snapshot directories written by states.mjs / flows.mjs.
# usage: compare.sh BEFORE_DIR AFTER_DIR
# Whitelist: in HTML files the preview page's own entry tag
#   <script type="module" src="./src/<name>-preview.tsx">
# is ignored (it only records which entry file served the page, e.g. after
# zcode-preview.tsx was renamed to shell-preview.tsx). Everything else must be
# byte-identical; calls-*.txt are compared as-is.
set -u
ENTRY='s#<script type="module" src="\./src/[a-z0-9-]*-preview\.tsx">#<script type="module" src="ENTRY">#g'
n=0; d=0
for f in "$1"/*.html "$1"/calls-*.txt; do
  [ -e "$f" ] || continue
  n=$((n+1))
  g="$2/$(basename "$f")"
  if [[ $f == *.html ]] && [ -e "$g" ]; then
    cmp -s <(sed "$ENTRY" "$f") <(sed "$ENTRY" "$g") || { d=$((d+1)); echo "DIFF $(basename "$f")"; }
  else
    cmp -s "$f" "$g" || { d=$((d+1)); echo "DIFF $(basename "$f")"; }
  fi
done
before=$(ls "$1" | grep -cE '\.html$|^calls-'); after=$(ls "$2" | grep -cE '\.html$|^calls-')
[ "$before" -eq "$after" ] || echo "COUNT MISMATCH $before vs $after"
echo "compared=$n diffs=$d"
