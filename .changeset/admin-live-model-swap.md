---
"@reelsaw/server": minor
---

Admins can switch models without a restart. Settings → System → Models has pickers for the language, transcription and alignment models that list what every configured provider offers (OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, the Vercel AI Gateway, and self-hosted Ollama or Speaches servers), with a typeahead across all of them. Self-hosted servers show which models are installed and download missing ones with a progress bar (Ollama `/api/pull`, Speaches registry). Saving verifies each model first: the provider's key is set, a self-hosted model is installed, and a transcription model returns word timestamps. Keys and base URLs stay in `.env`. The override is stored in the database so every process picks it up within seconds; a stage that is already running finishes with the model it started with. Also available over the API (`admin.models.get/catalog/set/test/pull`) and recorded in the admin event log.
