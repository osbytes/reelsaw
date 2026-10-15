#!/bin/sh
# Download the ONNX models Reelsaw runs on CPU. Usage: scripts/download-models.sh [dir=apps/server/models]
#   ultraface-rfb-320.onnx  face detection (MIT)                 1.2 MB
#   ppocrv4-det.onnx        burned-in text detection (Apache-2.0) 4.7 MB
#   silero-vad.onnx         voice activity / silence trimming (MIT) 2.3 MB
#   wav2vec2-base-960h/     CTC forced alignment, English (Apache-2.0) 95 MB (int8)
set -eu
DIR="${1:-apps/server/models}"
mkdir -p "$DIR/wav2vec2-base-960h"
get() { [ -s "$2" ] || { echo "downloading $(basename "$2")"; curl -fsSL -o "$2.part" "$1" && mv "$2.part" "$2"; }; }
get https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx "$DIR/ultraface-rfb-320.onnx"
get https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx "$DIR/ppocrv4-det.onnx"
get https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx "$DIR/silero-vad.onnx"
get https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/onnx/model_quantized.onnx "$DIR/wav2vec2-base-960h/model.onnx"
get https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/vocab.json "$DIR/wav2vec2-base-960h/vocab.json"
