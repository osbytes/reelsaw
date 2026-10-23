---
"@reelsaw/server": patch
---

The arm64 image starts again: SVG rasterising uses resvg compiled to WebAssembly instead of a native package that only existed for the build host's architecture.
