---
"@reelsaw/server": minor
---

Shots without a face no longer always show the whole frame. When one thing in the shot clearly moves (b-roll of a ship or a car, a product turned in the hand, a worker at a machine), automatic framing crops to 9:16 and follows it, holding the crop still when the subject stays put and panning with the same tripod smoothing as the speaker crop when it moves. The motion comes from the frames the face detector already decodes, with the camera's own pan taken out, so it costs no extra model. Anything less clear stays whole: motion spread across the frame (crowds, water, 3D gameplay), no motion, a subject wider than the crop, text the crop would cut, or a shot under two seconds. The editor labels these pieces "Follow subject", and `get_clip` reports them as `center` layout segments with `focus: "subject"` and their crop track.
