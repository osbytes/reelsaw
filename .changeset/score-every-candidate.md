---
"@reelsaw/server": patch
---

Clip selection scores every candidate. With a small self-hosted judge (such as qwen2.5:14b in Ollama), about a third of the moments found used to come back without a score and were ranked below all the others, and many of the rest got the same total (68) because the judge copied the prompt's example. The judge now gets an example with no numbers in it, any candidate it leaves out is asked about again on its own, and extra score samples read each batch in a different order.
