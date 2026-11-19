---
"@reelsaw/server": patch
---

Polish from a walk through the whole app. Browser tabs now name the page ("Budgeting talk · Reelsaw"), so several
open projects can be told apart. While a project is still running, its header no longer shows a green "Transcript
updated" as if it were done; it keeps showing the stage at work. The ⌘K palette shows each project's current status
instead of one from up to half a minute ago. Deleting a clip happens at once with Undo (the editor still asks when
unsaved edits would be lost), and Undo puts it back under its own number instead of at the end. Deep links into
Settings highlight the right section, sideways-scrolling tab rows fade at the edge that has more, opening a project
or the editor shows one loading skeleton instead of two, and "Resume following" on the transcript only appears when
the playhead's line is off screen.

Also: uploaded videos get a poster frame on the project page and its tile; ⌘K ranks a match in an action's name above
one in its description and, on a project page, offers that project's actions first; a re-render of one clip reports
"Re-rendered 1 clip in 0:25 · 3 ready"; deleting a selection of clips uses Undo instead of a dialog; empty lists show
one "New …" button; list counts read "3 projects" instead of "Showing 3 of 3"; the clip menu is grouped; the editor's
Cuts tab links to the clip's words in the transcript; the transcript toolbar no longer grows a row when the first fix
lands; buttons show a spinner instead of "…" while they work. The first ⌘K open shows its box at once (a quick second click used to close it again),
a project whose clips were all deleted says so and offers to restore them, and the transcript's selection bar no
longer hangs off the panel's edge.
