---
"@reelsaw/server": patch
---

Signing in to an account that is waiting for approval shows that waiting message instead of "Email not verified". The sign-in form asks for the current password, so a password manager does not generate a new one that was never stored. A repeat sign-up for an existing email is refused instead of looking successful.
