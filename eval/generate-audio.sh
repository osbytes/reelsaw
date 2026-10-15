#!/bin/bash
# Synthesize eval audio with macOS text-to-speech. Ground truth = the "text" field in cases.json.
# Usage: eval/generate-audio.sh [voice]   (default Samantha). Produces eval/audio/<id>.mp3 at 16 kHz mono like the pipeline.
set -e
cd "$(dirname "$0")"
VOICE=${1:-Samantha}
mkdir -p audio
python3 -c "import json;[print(c['id']+'\t'+c['text']) for c in json.load(open('cases.json'))]" | while IFS=$'\t' read -r id text; do
  say -v "$VOICE" -r 175 -o "audio/$id.aiff" "$text"
  ffmpeg -hide_banner -loglevel error -y -i "audio/$id.aiff" -ac 1 -ar 16000 -b:a 48k -f mp3 "audio/$id.mp3"
  rm -f "audio/$id.aiff"
  echo "audio/$id.mp3"
done
