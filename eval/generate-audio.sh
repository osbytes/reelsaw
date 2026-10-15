#!/bin/bash
# Synthesize transcription-eval audio with macOS text-to-speech. Ground truth = the "text" field of
# eval/fixtures/transcription/cases.json. The eval runner does this automatically on macOS when audio
# is missing; this script is for regenerating by hand / with another voice.
# Usage: eval/generate-audio.sh [voice]   (default Samantha) → eval/.cache/transcription-audio/<id>.mp3 (16 kHz mono)
set -e
cd "$(dirname "$0")"
VOICE=${1:-Samantha}
OUT=.cache/transcription-audio
mkdir -p "$OUT"
python3 -c "import json;[print(c['id']+'\t'+c['text']) for c in json.load(open('fixtures/transcription/cases.json'))]" | while IFS=$'\t' read -r id text; do
  say -v "$VOICE" -r 175 -o "$OUT/$id.aiff" "$text"
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/$id.aiff" -ac 1 -ar 16000 -b:a 48k -f mp3 "$OUT/$id.mp3"
  rm -f "$OUT/$id.aiff"
  echo "$OUT/$id.mp3"
done
