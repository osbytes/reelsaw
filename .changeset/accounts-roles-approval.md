---
"@reelsaw/server": minor
---

Accounts and roles: the first account is the admin; `SIGNUP_MODE=open|approval|closed` controls sign-ups (approval holds new accounts on a "Waiting for approval" page until an admin approves them on the new Users page). Admins can suspend, reinstate, promote and remove accounts; `reelsaw users|approve|make-admin` from the shell. Optional email (`EMAIL_DRIVER=smtp|resend`) sends approval notices, password resets and verification.

**Upgrade:** existing accounts stay approved; the oldest becomes the admin. `ALLOW_SIGNUP=false` still means `closed`.
