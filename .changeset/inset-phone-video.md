---
"@reelsaw/server": minor
---

Phone footage edited into a 16:9 video between blurred or black bars is now cropped to the picture itself. A vertical clip fills the 9:16 frame instead of showing the whole frame, bars and all, at a third of the width; a square or 4:3 inset is shown at its own shape over a blurred copy of itself. Automatic framing only: "Whole frame" still shows the whole frame, and a crop set on the section wins. The editor labels these pieces "Inset video", and `get_clip` reports the crop as `inset` on the layout segment.
