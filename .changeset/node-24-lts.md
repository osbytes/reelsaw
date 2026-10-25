---
"@reelsaw/server": patch
---

The Docker image and production bundle now run Node 24 LTS (the same line CI already uses). The base image stays digest-pinned on the 24 line so Dependabot can pick up 24.x security releases.
