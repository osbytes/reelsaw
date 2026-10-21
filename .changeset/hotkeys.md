---
"@reelsaw/server": patch
---

Keyboard shortcuts go through one binding helper (react-hotkeys-hook) instead of hand-rolled listeners, so the typing rule and the platform modifier are the same on every screen. ⌘K no longer splits framing in the clip editor; it only opens the command palette (⌘B splits, as the `?` sheet says).
