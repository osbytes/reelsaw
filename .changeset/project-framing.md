---
"@reelsaw/server": minor
---

One clip's framing for the whole project. For a recording whose layout never changes (a slide deck with a webcam tile, a fixed camera), set the framing on one clip and pick "Use for all N clips…" on its Framing tab: the section's mode and its nudge, subject or crop become the project's framing (`reframe` and the new `reframeAdjust` setting), every clip's own sections are cleared, the finished clips re-render, and clips added later get it too. A clip without framing of its own now shows and renders the project's framing; editing it makes the clip's own, and "Use the project framing" takes it back. Over MCP `apply_framing` does the same from a clip id, `reframeAdjust` is a project setting like the others, and the CLI has `apply-framing`.
