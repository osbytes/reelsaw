---
"@reelsaw/server": patch
"@reelsaw/web": patch
---
Sign-in and sign-up rate limits now key on each visitor's own address behind a reverse proxy (Railway, Caddy), instead of one bucket shared by everyone. A link longer than the account's remaining minutes is refused when the project is created, with the upgrade offer, instead of becoming a failed project. "Jobs at once" now counts only what the user asked for, so a project's own renders no longer block the next request. Sign-ups that must confirm their email are now counted in product analytics.
