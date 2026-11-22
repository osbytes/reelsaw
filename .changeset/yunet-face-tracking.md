---
"@reelsaw/server": minor
---

Reframing runs on a stronger face detector: YuNet (MIT, 230 KB, with five landmarks per face) replaces UltraFace, at the source's own shape and about 640x360 pixels instead of a squashed 320x240. It finds small webcam faces in meeting recordings, wide-shot faces and vertical-video faces UltraFace missed, and no longer boxes round pans and other cookware as faces. Each face now keeps an identity across frames, so a split keeps each speaker on their own face when a hand or a second detection appears beside them, and a poster is still dropped when someone walks past it. Self-hosted installs outside Docker: run `pnpm models:download` to fetch `yunet-2026may.onnx`, and update `FACE_MODEL_PATH` if you set it by hand.
