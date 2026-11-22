#!/bin/sh
# Download the ONNX models Reelsaw runs on CPU. Usage: scripts/download-models.sh [dir=apps/server/models]
#   ultraface-rfb-320.onnx  face detection (MIT)                 1.2 MB
#   ppocrv4-det.onnx        burned-in text detection (Apache-2.0) 4.7 MB
#   silero-vad.onnx         voice activity / silence trimming (MIT) 2.3 MB
#   wav2vec2-base-960h/     CTC forced alignment, English (Apache-2.0) 95 MB (int8)
#   lr-asd/                 active speaker detection, LR-ASD as exported by DeepTalk-ASD (MIT) 3.4 MB
# Every source is pinned to an immutable commit/tag and every file is checked against a sha256, so a
# moved branch or a tampered mirror fails the build instead of shipping. Licences: THIRD_PARTY.md.
# To bump one: change the ref in its URL, download it once, run `sha256sum` on it, update the hash.
set -eu
DIR="${1:-apps/server/models}"
mkdir -p "$DIR/wav2vec2-base-960h" "$DIR/lr-asd"
# get <url> <dest> <sha256>
get() {
  [ -s "$2" ] || { echo "downloading $(basename "$2")"; curl -fsSL -o "$2.part" "$1" && mv "$2.part" "$2"; }
  echo "$3  $2" | sha256sum -c - >/dev/null || { echo "sha256 mismatch for $2 (from $1); delete it and retry, or update the pin" >&2; exit 1; }
}
GH_ONNX=4c46cd00fbdb7cd30b6c1c17ab54f2e1f4f7b177        # onnx/models
HF_RAPIDOCR=1cfba2e90fc938db55889873735088de210cc173    # SWHL/RapidOCR
HF_WAV2VEC=a19f851b3d42865797e410752b4c570c871e4825     # Xenova/wav2vec2-base-960h
GH_DEEPTALK=f33d15e0bf2a565a82e25936dca7e67d9eaf8066    # huyyxy/DeepTalk-ASD (Git LFS, served from media.githubusercontent.com)
get https://github.com/onnx/models/raw/$GH_ONNX/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx "$DIR/ultraface-rfb-320.onnx" 34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017
get https://huggingface.co/SWHL/RapidOCR/resolve/$HF_RAPIDOCR/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx "$DIR/ppocrv4-det.onnx" d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9
get https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx "$DIR/silero-vad.onnx" 2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f
get https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/$HF_WAV2VEC/onnx/model_quantized.onnx "$DIR/wav2vec2-base-960h/model.onnx" cd5040c147381580ed73258143dd8e0c28e800a09e74ee42ee2b3e8cb4d760a3
get https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/$HF_WAV2VEC/vocab.json "$DIR/wav2vec2-base-960h/vocab.json" 4178db26b3c7570f6a47f14ac6a1c7b32950b8c2800fb097287e53776934f1c5
get https://media.githubusercontent.com/media/huyyxy/DeepTalk-ASD/$GH_DEEPTALK/weights/audio_frontend.onnx "$DIR/lr-asd/audio_frontend.onnx" a1b55df7105fb730196b527f3e5c8d39f4ab38013a21d01c15404e870a8a5cb3
get https://media.githubusercontent.com/media/huyyxy/DeepTalk-ASD/$GH_DEEPTALK/weights/visual_frontend.onnx "$DIR/lr-asd/visual_frontend.onnx" af8e213b148d573008c14068ebb6255779b2cce1fef56416e276bd5f49ca6e29
get https://media.githubusercontent.com/media/huyyxy/DeepTalk-ASD/$GH_DEEPTALK/weights/av_backend.onnx "$DIR/lr-asd/av_backend.onnx" 13ec6c03885e104b7bca0f30b0574f0e3ffc896ca6a7b9d71e75ca413c75eb55
