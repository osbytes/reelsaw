#!/bin/bash
# Capture the measurable half of a gold-standard reference clip (see eval/references/README.md).
# Usage: eval/references/capture.sh <url> <slug>
#   → eval/references/<slug>/measured.json   cuts, loudness, silences, stream info, counts at capture
#   → eval/references/<slug>/cuts.txt        scene-cut timestamps, one per line
#   → eval/references/<slug>/sheet.jpg       contact sheet, one frame every 3 s
#   The download itself lands in eval/.cache/references/<slug>/ (gitignored). Needs ffmpeg + yt-dlp
#   (YTDLP_PATH, `yt-dlp` on PATH, or `uvx yt-dlp`).
set -euo pipefail
URL=${1:?url}; SLUG=${2:?slug}
cd "$(dirname "$0")"
OUT="$SLUG"; CACHE="../.cache/references/$SLUG"
mkdir -p "$OUT" "$CACHE"
FFMPEG=${FFMPEG_PATH:-ffmpeg}; FFPROBE=${FFPROBE_PATH:-ffprobe}
if [ -n "${YTDLP_PATH:-}" ]; then YTDLP=("$YTDLP_PATH"); elif command -v yt-dlp >/dev/null; then YTDLP=(yt-dlp); else YTDLP=(uvx yt-dlp); fi

MP4="$CACHE/clip.mp4"; INFO="$CACHE/clip.info.json"
if [ ! -f "$MP4" ]; then
  "${YTDLP[@]}" -q --no-warnings --no-playlist -f "bv*[height<=1080]+ba/b" --merge-output-format mp4 \
    --write-info-json -o "$CACHE/clip.%(ext)s" "$URL"
fi

# scene cuts (same detector the pipeline's scenes stage builds on; 0.25 catches soft cuts behind captions)
"$FFMPEG" -v info -i "$MP4" -vf "select='gt(scene,0.25)',showinfo" -vsync vfr -f null - 2>&1 \
  | grep -o "pts_time:[0-9.]*" | sed 's/pts_time://' | awk '{printf "%.2f\n", $1}' > "$OUT/cuts.txt"
# loudness and silences
LOUD=$("$FFMPEG" -v info -i "$MP4" -af ebur128=peak=true -f null - 2>&1 | grep -A9 Summary)
SIL=$("$FFMPEG" -v info -i "$MP4" -af silencedetect=n=-35dB:d=0.4 -f null - 2>&1 | grep -o "silence_duration: [0-9.]*" | awk '{print $2}' | paste -sd, - || true)
# contact sheet
"$FFMPEG" -v error -y -i "$MP4" -vf "fps=1/3,scale=240:-1,tile=6x7" -frames:v 1 -q:v 6 "$OUT/sheet.jpg"

python3 -I - "$MP4" "$INFO" "$OUT/cuts.txt" "$LOUD" "$SIL" "$URL" "$OUT/measured.json" <<'PY'
import json, subprocess, sys, re, statistics, datetime
mp4, info_path, cuts_path, loud, sil, url, out = sys.argv[1:]
info = json.load(open(info_path))
probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", mp4]))
v = next(s for s in probe["streams"] if s["codec_type"] == "video")
dur = float(probe["format"]["duration"])
cuts = [float(x) for x in open(cuts_path).read().split()]
edges = [0.0] + cuts + [dur]
gaps = [b - a for a, b in zip(edges, edges[1:]) if b - a > 0.15]
num = lambda k: (m := re.search(k + r":\s*(-?[0-9.]+)", loud)) and float(m.group(1))
sils = [float(x) for x in sil.split(",") if x]
json.dump({
  "url": url, "capturedAt": datetime.date.today().isoformat(),
  "title": info.get("title"), "channel": info.get("channel"), "uploadDate": info.get("upload_date"),
  "viewsAtCapture": info.get("view_count"), "likesAtCapture": info.get("like_count"),
  "duration": round(dur, 2), "width": v["width"], "height": v["height"], "fps": v["r_frame_rate"],
  "cuts": {"count": len(cuts), "perMinute": round(len(cuts) / dur * 60, 1),
           "medianShotSeconds": round(statistics.median(gaps), 2), "longestShotSeconds": round(max(gaps), 2)},
  "audio": {"integratedLufs": num("I"), "loudnessRangeLu": num("LRA"),
            "silences": {"thresholdDb": -35, "minSeconds": 0.4, "count": len(sils), "totalSeconds": round(sum(sils), 2)}},
}, open(out, "w"), indent=2)
print(open(out).read())
PY
