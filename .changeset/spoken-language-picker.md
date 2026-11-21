---
"@reelsaw/server": patch
---

The spoken language is a searchable list of the languages the transcriber knows, by name and by each language's own name ("German", "Deutsch"), in Project defaults and under Advanced when you start a project. It used to be a free-text box in Project defaults only, where "Englsh" or "pt-br" was saved as typed. The names come from the browser and the server's own language data, not from a list kept in Reelsaw, and the server reads a language a model reports by name ("german") through the same list.

On New project, "Detect automatically" (and any optional setting you empty there) now overrides your project defaults instead of being filled back in from them; create_project and `reelsaw create-project` take the same `clear` list as an update.
