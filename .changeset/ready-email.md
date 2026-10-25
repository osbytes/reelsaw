---
"@reelsaw/server": minor
---

When email is on, a finished project schedules one note. Further projects that finish while it is waiting join the same email, and it is sent only if you have not come back. A first project, and later the 10th, 25th, 50th and 100th, get a line of their own.

Every note carries a one-click unsubscribe (`List-Unsubscribe`, RFC 8058) and a footer link; the note can also be turned off under Settings → Account, with the `get_email_preferences` / `set_email_preferences` MCP tools, or with `reelsaw email-prefs <email> --ready-email off`.
