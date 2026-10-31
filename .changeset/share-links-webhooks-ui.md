---
"@reelsaw/server": patch
---

Share links and webhooks are easier to use in the browser and on a phone. When the browser blocks the clipboard, "Copy share link" (and every Copy button for links and secrets) shows the link to copy by hand instead of an error, so a link that was made is never lost. On a phone, a webhook's status and last delivery get their own line, the delivery log keeps its time inside the card, and share links show their state, expiry and uses. "Rotate secret" is disabled while a rotation is still open and says until when; rotation messages give the time as `2026-11-01 21:57 UTC`. "Revoke all share links" stays hidden until there is one to revoke, the clip menu's "Copy link" is now "Copy page link" so it is not mistaken for a share link, and an admin's Users link moves into the account menu on a phone so the top bar fits.
