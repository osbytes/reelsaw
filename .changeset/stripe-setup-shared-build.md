---
"@reelsaw/server": patch
---

`pnpm stripe:setup` rebuilds `@reelsaw/shared` first so a stale shared build cannot miss exports like `billingPath`.
