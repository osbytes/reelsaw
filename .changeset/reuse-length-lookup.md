---
"@reelsaw/server": patch
---

Creating a project from a link is quicker on accounts with a monthly minutes limit. The video's length was looked up with yt-dlp when the link was checked, again when the project was created and again before the download; a link's length is now looked up once and reused for ten minutes, so Create no longer waits on a second lookup. A lookup that fails is not kept, and the limit is still enforced on the downloaded file.
