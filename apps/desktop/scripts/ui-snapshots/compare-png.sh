#!/usr/bin/env bash
# Pixel comparison of two snapshot directories (PNG only; compare.sh covers HTML and calls).
# Usage: scripts/ui-snapshots/compare-png.sh BEFORE_DIR AFTER_DIR
# Prints, per differing PNG, the number of differing pixels and the bounding box of the
# differences, then a summary. Run it on two snapshot runs of the SAME code first to see the
# run-to-run noise (live clock, relative timestamps, transitions); a change is clean when its
# differences stay within that noise.
set -u
A="$1"; B="$2"; n=0; d=0; max=0; missing=0
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
for f in "$A"/*.png; do
  b="$(basename "$f")"; n=$((n+1))
  if [ ! -f "$B/$b" ]; then echo "MISSING $b"; missing=$((missing+1)); continue; fi
  ae="$(magick compare -metric AE "$f" "$B/$b" null: 2>&1 | cut -d' ' -f1)"
  [ "$ae" = "0" ] && continue
  d=$((d+1)); [ "${ae%.*}" -gt "$max" ] && max="${ae%.*}"
  magick compare -metric AE -compose src -highlight-color red -lowlight-color none "$f" "$B/$b" "png:$TMP" 2>/dev/null
  echo "DIFF $b pixels=$ae box=$(magick "$TMP" -alpha extract -trim -format '%wx%h%O' info:)"
done
echo "png=$n differing=$d max_pixels=$max missing=$missing"
