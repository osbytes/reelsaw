---
"@reelsaw/server": minor
---

Framing follows the source's cutting. Scene cuts are now detected on every clip at render time (they used to reach the layout only when a project opted into scene refinement), and the layout may change at every cut: a multi-camera talk show that alternates a close-up with a wide shot every second or two gets a full-frame close-up, then the wide shot, then the close-up again, instead of one split held across a dozen shots with a pane framed on an empty seat. A wide shot of three or more people is shown whole rather than split between two of them. Importing an issue report whose project was re-rendered no longer fails on its timestamps.
