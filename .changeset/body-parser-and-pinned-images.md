---
"@reelsaw/server": patch
---

Dependency fix: body-parser 2.4.0 (GHSA-27r3-jxmh-p828, a denial of service through trailing bytes after a compressed request, reachable through the MCP endpoint's Express layer). The image's base layers are now pinned by digest and Dependabot keeps them, the npm packages and the workflow actions current.
