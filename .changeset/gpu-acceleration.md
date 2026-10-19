---
"@reelsaw/server": minor
---

Use the GPU where it pays. `docker-compose.gpu.yml` hands an NVIDIA card to Speaches (`SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cuda`, so `faster-whisper-large-v3` transcribes faster than `small` did on the CPU), to Ollama in a container, and to the app, where ffmpeg now encodes clips, intros and outros with `h264_nvenc` when `FFMPEG_ENCODER=auto` finds it at boot (VideoToolbox on a Mac outside Docker); a hardware encoder that fails mid-render falls back to libx264 for that clip. `ONNX_EXECUTION_PROVIDER` moves the face, text and alignment models to CUDA, CoreML or DirectML with a CPU fallback (CPU stays the default: measured faster on Apple silicon). Settings → System → Overview and the new `reelsaw machine` command show the GPU the process sees, the encoder in use and why, and where each on-device model runs.
