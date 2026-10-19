# Third-party models, fonts and tools

Reelsaw's own code is under the repository licence. The image also bundles the model weights, font and
download tool below, each under its own licence. Weights are fetched at image build time by
`scripts/download-models.sh`, pinned to a commit or tag and verified by sha256. This file is copied to
`/app/THIRD_PARTY.md` in the image.

| Component | Used for | Source (pinned) | Licence |
| --- | --- | --- | --- |
| UltraFace RFB-320 (`ultraface-rfb-320.onnx`) | face detection for reframing | [onnx/models](https://github.com/onnx/models/tree/4c46cd00fbdb7cd30b6c1c17ab54f2e1f4f7b177/validated/vision/body_analysis/ultraface) (Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) | MIT (SPDX header in the model README; upstream repo MIT, Copyright (c) 2019 linzai) |
| PP-OCRv4 text detector (`ppocrv4-det.onnx`) | find burned-in text to avoid | [SWHL/RapidOCR](https://huggingface.co/SWHL/RapidOCR/tree/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4), converted from PaddleOCR | Apache-2.0 (model card; PaddleOCR and RapidOCR are Apache-2.0) |
| Silero VAD v5.1.2 (`silero-vad.onnx`) | voice activity, silence trimming | [snakers4/silero-vad](https://github.com/snakers4/silero-vad/tree/v5.1.2) | MIT (Copyright (c) 2020-present Silero Team) |
| wav2vec2-base-960h, int8 ONNX (`wav2vec2-base-960h/`) | CTC forced alignment of cut boundaries | [Xenova/wav2vec2-base-960h](https://huggingface.co/Xenova/wav2vec2-base-960h/tree/a19f851b3d42865797e410752b4c570c871e4825), converted from facebook/wav2vec2-base-960h | Apache-2.0 (facebook/wav2vec2-base-960h model card; the Xenova conversion declares no licence of its own) |
| DejaVu fonts (Debian `fonts-dejavu-core`) | caption rendering fallback | Debian package in the base image | Bitstream Vera licence with DejaVu changes (public domain); free to use, embed and redistribute, not to be sold on their own |
| gosu (Debian `gosu`) | drop from root to `node` after fixing volume-mounted `DATA_DIR` | Debian package in the base image | Apache-2.0 (Debian package; upstream [tianon/gosu](https://github.com/tianon/gosu)) |
| yt-dlp | downloading source videos | [yt-dlp/yt-dlp 2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19), sha256-pinned in the Dockerfile | Unlicense (public domain) |

Not bundled but used at run time: ffmpeg (Debian package, LGPL/GPL depending on build), Ollama and
Speaches (separate containers or hosts, with their own licences), and whatever language and speech
models you point the app at; check those models' licences for your use.

When you bump a pin in `scripts/download-models.sh` or the `Dockerfile`, re-read the upstream licence
and update this table.
