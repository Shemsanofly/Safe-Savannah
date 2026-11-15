#!/usr/bin/env bash
# Download a CC-licensed video from Wikimedia Commons, cut a segment, and record
# its attribution next to it. Output goes to fixtures/local/ (git-ignored).
#
#   scripts/fetch-commons-clip.sh "Mum_and_baby_Elephant_walking_toward_us..webm" 96 40 elephants-near
#
# Always check the licence and author on the Commons file page before using a
# clip in a demo or sharing it, and credit it as the licence requires.
set -euo pipefail
FILE="${1:?Commons file name, e.g. Some_clip.webm}"
START="${2:-0}"
DURATION="${3:-30}"
NAME="${4:-$(basename "${FILE%.*}")}"
UA="safe-savannah-fixtures/0.1"
OUT_DIR="fixtures/local"
mkdir -p "$OUT_DIR"

HASH=$(printf '%s' "${FILE// /_}" | md5sum | cut -c1-2)
SRC="https://upload.wikimedia.org/wikipedia/commons/transcoded/${HASH:0:1}/${HASH}/${FILE// /_}/${FILE// /_}.480p.vp9.webm"
TMP="$OUT_DIR/.${NAME}.download.webm"
echo "Downloading 480p transcode..."
if ! curl -fsSL -A "$UA" -o "$TMP" "$SRC"; then
  echo "Transcode not available; downloading the original file"
  curl -fsSL -A "$UA" -o "$TMP" "https://upload.wikimedia.org/wikipedia/commons/${HASH:0:1}/${HASH}/${FILE// /_}"
fi
ffmpeg -hide_banner -loglevel error -y -ss "$START" -i "$TMP" -t "$DURATION" -an -c:v libx264 -crf 26 -movflags +faststart "$OUT_DIR/$NAME.mp4"
rm -f "$TMP"

cat > "$OUT_DIR/$NAME.attribution.txt" <<TXT
Source: https://commons.wikimedia.org/wiki/File:${FILE// /_}
Segment: start ${START}s, duration ${DURATION}s, re-encoded without audio.
Licence and author: see the file page above; credit as its licence requires.
Retrieved: $(date -u +%Y-%m-%dT%H:%M:%SZ)
TXT
echo "Wrote $OUT_DIR/$NAME.mp4 and $OUT_DIR/$NAME.attribution.txt"
