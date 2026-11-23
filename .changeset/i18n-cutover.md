---
"@reelsaw/server": minor
---

Reelsaw is ready for other languages. Every string a person reads now comes from a message catalogue: the web app, the server's errors (each with a stable code and its parameters beside the sentence), notices, emails, MCP results, CLI lines and reelsaw.com. Numbers, sizes, amounts and dates are formatted for the reader's locale. Each account can choose its language and time zone under Settings → Account → Language and region, with `get_locale_preferences` / `set_locale_preferences` over MCP, or with `reelsaw locale-prefs <email>`; emails are written in the recipient's language, with dates in their time zone. English is the only language that ships today, and a translation is a pull request to the catalogues (docs/I18N.md).
