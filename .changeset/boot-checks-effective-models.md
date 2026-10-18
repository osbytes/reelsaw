---
"@reelsaw/server": patch
---
Boot checks the models that will actually run (including an admin override), rejects transcription models without word timestamps, and the installer picks the language model by RAM, verifies the container can reach a host Ollama, and the image pins yt-dlp and every model weight by checksum.
