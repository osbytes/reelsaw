---
"@reelsaw/server": patch
---
Live updates on the project page and the clip editor now recover after a sign-in expiry or a network blip (with a small "reconnecting" note), and a long activity log stays complete after a reconnect. Uploads check the file size against the server's limit up front, can be cancelled one by one or all at once, and warn before you close the tab mid-upload.
