---
"@reelsaw/server": patch
---

Failures that another attempt cannot change now fail the project right away instead of spending its retries: a private or removed video, a link that is not a supported video, a video over the download size limit, a malformed or internal link, a source with no audio, an upload that is gone, a transcription with no words, and an analysis that found no usable clips. A dead link (404 / 410) is still tried through every configured download proxy first, since a site can answer 404 to one region only. Retryable cases stay retryable: region blocks, age checks, bot checks, rate limits, server errors, an expired media URL, and a failed DNS lookup.
