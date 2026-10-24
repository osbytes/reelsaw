---
"@reelsaw/server": patch
---

A re-rendered clip plays at once. The clip's video and thumbnail are served at a URL that never changes, with an hour-long cache, so after a re-render the project page and the clip preview could replay the previous render for up to an hour (a moved caption or a new crop looked as if it had not been applied). The clip media now carries an ETag and asks the browser to check before replaying, so an unchanged file still costs one small request and a re-rendered one is fetched anew.
