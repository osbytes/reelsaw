---
"@reelsaw/server": patch
---
Game and app interfaces are no longer blurred as burned-in captions. The on-screen text scan now tells interface text (scores, player lists and menu buttons pinned to the side of a gameplay or screen recording) from subtitles, logos and lower thirds, and leaves the interface visible. New projects get this automatically. For an existing project, an operator can re-scan with `reelsaw overlays <projectId> --store` and then re-render the clips.
