# Third-party models, fonts and tools

Reelsaw's own code is under the repository licence. The image also bundles the model weights, font, word lists and
download tool below, each under its own licence. Weights are fetched at image build time by
`scripts/download-models.sh`, pinned to a commit or tag and verified by sha256. This file is copied to
`/app/THIRD_PARTY.md` in the image.

| Component | Used for | Source (pinned) | Licence |
| --- | --- | --- | --- |
| YuNet 2026may (`yunet-2026may.onnx`) | face detection and landmarks for reframing | [opencv/opencv_zoo](https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_detection_yunet) (ShiqiYu/libfacedetection.train) | MIT (the model directory's `LICENSE`, Copyright (c) 2020 Shiqi Yu) |
| PP-OCRv4 text detector (`ppocrv4-det.onnx`) | find burned-in text to avoid | [SWHL/RapidOCR](https://huggingface.co/SWHL/RapidOCR/tree/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4), converted from PaddleOCR | Apache-2.0 (model card; PaddleOCR and RapidOCR are Apache-2.0) |
| Silero VAD v5.1.2 (`silero-vad.onnx`) | voice activity, silence trimming | [snakers4/silero-vad](https://github.com/snakers4/silero-vad/tree/v5.1.2) | MIT (Copyright (c) 2020-present Silero Team) |
| wav2vec2-base-960h, int8 ONNX (`wav2vec2-base-960h/`) | CTC forced alignment of cut boundaries | [Xenova/wav2vec2-base-960h](https://huggingface.co/Xenova/wav2vec2-base-960h/tree/a19f851b3d42865797e410752b4c570c871e4825), converted from facebook/wav2vec2-base-960h | Apache-2.0 (facebook/wav2vec2-base-960h model card; the Xenova conversion declares no licence of its own) |
| DejaVu fonts (Debian `fonts-dejavu-core`) | caption rendering fallback | Debian package in the base image | Bitstream Vera licence with DejaVu changes (public domain); free to use, embed and redistribute, not to be sold on their own |
| SCOWL word lists via `wordlist-english` 1.2.x | "everyday English" in entity correction | [jacksonrayhamilton/wordlist-english](https://github.com/jacksonrayhamilton/wordlist-english), npm dependency pinned by `pnpm-lock.yaml` | MIT (package); SCOWL: Copyright 2000-2016 by Kevin Atkinson and others, permissive notice kept in the package's `Copyright` file |
| yt-dlp | downloading source videos | [yt-dlp/yt-dlp 2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19), sha256-pinned in the Dockerfile | Unlicense (public domain) |

Not bundled but used at run time: ffmpeg (Debian package, LGPL/GPL depending on build), Ollama and
Speaches (separate containers or hosts, with their own licences), and whatever language and speech
models you point the app at; check those models' licences for your use.

When you bump a pin in `scripts/download-models.sh` or the `Dockerfile`, re-read the upstream licence
and update this table.
