---
"@reelsaw/server": minor
---

Plans can set the resolution a link is downloaded at (`sourceHeight` in the plan list). On a capped plan the project keeps a small preview of the video for transcription, analysis and the editor, with the full audio. Each clip renders from a full-quality window of the video fetched for it. Nearby clips share one window, a window is reused by every re-render that fits inside it, and a clip edited past its window fetches only the missing stretch. Windows are placed on the source's clock by matching their audio to the preview, so captions and cuts line up as before. The project page and the clip editor mark a preview source and name the plan that downloads at full quality. `get_project` reports `sourcePreviewHeight`. Window downloads are fetched by ffmpeg, which supports HTTP proxies only; see Troubleshooting for `YTDLP_PROXY`.
