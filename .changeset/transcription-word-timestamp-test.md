---
"@reelsaw/server": minor
---

Transcription through OpenRouter and other OpenAI-compatible servers. The compatible provider (`OPENAI_COMPATIBLE_*`) now serves transcription models as well as language models, so `TRANSCRIPTION_MODEL=openrouter:openai/whisper-large-v3-turbo` works next to `AI_MODEL=openrouter:…`. Whether a transcription model returns the word timestamps that cuts and captions need is no longer decided from its name: the first time Reelsaw meets a model it transcribes a 5-second test clip and checks the answer, remembers the result for 30 days, and refuses a model that fails with that reason. Test under Settings → Models runs the clip again, and the model picker marks which models passed. The picker also lists OpenRouter's speech models and the AI Gateway's transcription models from what those services report.
