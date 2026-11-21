---
"@reelsaw/server": patch
---

An audio file with cover art (a podcast episode, a music track) now makes clips with the art as the picture. Before, every clip of such a source came out as sound alone and failed on its thumbnail, retry after retry. A file with sound and no picture at all is now refused when it is added, with a message saying what to upload instead, rather than failing later at render.
