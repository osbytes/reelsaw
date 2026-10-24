---
"@reelsaw/server": minor
---

Crops can be set by hand on top of what framing decides. Right-click the picture in the editor (or a section on the timeline, or the Crop… button on a section) for Set crop…, which fixes the pane under the pointer to an exact part of the source: a box to drag, resize or draw over the whole source frame, with the numbers beside it, starting from what shows now; a split's two panes, a stack's screen and speaker, and a fitted frame each take their own. A crop shaped like the pane fills it, any other shape is fitted over a blurred copy like a webcam tile, and dragging the picture moves a fixed crop. Over MCP, `update_clip` sections take `crop`, `crop2` and `contentCrop`. The hook on the preview has the same right-click menu as a text layer: edit it in place (or double-click it), centre it, reset its position, or hide it.
