---
"@reelsaw/server": minor
---

Operators can set a forgotten password from the shell without email: `reelsaw set-password you@example.com`. `--must-change` signs them in with that temporary password and then a blocking page asks for a new one (no current-password field). Other devices are signed out; API keys keep working.

**Upgrade:** existing databases add `user.must_change_password` at boot (default off). On a box without email, `docker compose exec app reelsaw set-password you@example.com` replaces a forgotten password; pass `--must-change` when the operator invented it.
