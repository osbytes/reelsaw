# @reelsaw/server

## 0.54.0

### Minor Changes

- [#387](https://github.com/osbytes/reelsaw/pull/387) [`dd6d265`](https://github.com/osbytes/reelsaw/commit/dd6d26503538608e92fef10ac540f0cde1941ac8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `POSTHOG_PROXY=true` sends the web app's PostHog events through the app's own origin at `/api/relay`, which the server forwards to `POSTHOG_HOST`, so ad blockers that block posthog.com do not drop them. Cookies and authorization headers are not forwarded; the client address is, when `TRUST_PROXY` is on. Off by default.

## 0.53.0

### Minor Changes

- [#385](https://github.com/osbytes/reelsaw/pull/385) [`eb803dc`](https://github.com/osbytes/reelsaw/commit/eb803dcaff96e22767c6f0d114693f9bcef1df4c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Product updates are an email topic of their own. Settings → Account, `set_email_preferences` and `reelsaw email-prefs <email> --product_updates off` turn the occasional email about new features on or off, separately from the note sent when projects finish. It is on until an account turns it off. Reelsaw does not send these itself: an operator's broadcast goes to the verified accounts that have it on.

### Patch Changes

- [#383](https://github.com/osbytes/reelsaw/pull/383) [`d656ab2`](https://github.com/osbytes/reelsaw/commit/d656ab27c880677864f66eebfb526b67ac0fc029) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Logs say more about why something failed: a slow request carries the event-loop delay, a process killed by a signal logs memory use and whether the container's memory limit killed it, Postgres pool errors carry the pool's connection counts, storage failures carry the project and clip, and a failed ffmpeg run leads with its own reason. New gauges: `reelsaw.event_loop.delay` and `reelsaw.db.pool.connections`.

- [#382](https://github.com/osbytes/reelsaw/pull/382) [`05b9a63`](https://github.com/osbytes/reelsaw/commit/05b9a638d3df54f67b5ca153f8be74f2c71e908e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A clip whose picture ends before its sound no longer fails after rendering: its thumbnail is taken from an earlier frame instead of a point past the last one. A clip with no picture at all now fails at once with a plain reason instead of retrying.

## 0.52.2

### Patch Changes

- [#380](https://github.com/osbytes/reelsaw/pull/380) [`f2861e9`](https://github.com/osbytes/reelsaw/commit/f2861e9bea7cc35229b6baeee6802eb21d03dceb) Thanks [@dillonstreator](https://github.com/dillonstreator)! - In Settings → System → Queue, an admin's links to another account's queued or failed work now open that owner on the users page (Open account) instead of a project page they cannot see. Their own projects still open directly.

## 0.52.1

### Patch Changes

- [#378](https://github.com/osbytes/reelsaw/pull/378) [`b98627c`](https://github.com/osbytes/reelsaw/commit/b98627c876a2a10b8f5e66d1e4f8e36f77512e06) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Choosing ranges past your minutes now says so, with the upgrade offer, when you check a link, create a project or clip more of one. Before, those three refused with a "something went wrong" error instead.

## 0.52.0

### Minor Changes

- [#374](https://github.com/osbytes/reelsaw/pull/374) [`a628a36`](https://github.com/osbytes/reelsaw/commit/a628a36a682a41f02470dd608f4a93864c831966) Thanks [@WaveHost77](https://github.com/WaveHost77)! - Ship the Russian locale: `ru` joins `SHIPPED_LOCALES` and the lingui configs, with translated web, server and website catalogues (UI, errors, notices, emails, CLI and the marketing site). Set it per account under Settings → Account → Language and region; missing messages fall back to English.

### Patch Changes

- [#375](https://github.com/osbytes/reelsaw/pull/375) [`925814c`](https://github.com/osbytes/reelsaw/commit/925814c5ace462679ea64b54ce6796246130e79b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A run stopped because you deleted its project is logged as information instead of an error, so the server log's errors are failures someone needs to look at.

## 0.51.1

### Patch Changes

- [#369](https://github.com/osbytes/reelsaw/pull/369) [`ca287e2`](https://github.com/osbytes/reelsaw/commit/ca287e2ae7e2f75f168835199cb8ae7074307829) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Name fixes stop flagging everyday words: entities made of ordinary words, handles and spelled-out letters no longer replace what was heard, a real word is offered only when it sounds the same as the name, web addresses and possessives are left alone, and a fix you rejected is not proposed again in your other projects.

- [#370](https://github.com/osbytes/reelsaw/pull/370) [`1005590`](https://github.com/osbytes/reelsaw/commit/10055908aa6bb348aa6588d95ac43cd4afae3dc8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Projects that clipped only ranges or the start of a long video now say so on their Projects card (how much of the
  video, with a strip of the clipped parts, and how many ranges), in the ⌘K palette and in `list_projects`
  (`processed`). Range fixes: Most replayed peaks longer than the longest clip are added as ranges to find clips in
  instead of exact clips the planner then rejects (also for `rangesFrom` over MCP and the CLI); ranges keep their
  numbers when one is added later; expected processing times count the ranges, not the whole video, and no longer
  skew the estimates of other projects; each range's download says which part it is; a range that found no moments
  keeps its heading. On a phone, New project's footer no longer overlaps itself, Most replayed chips scroll in one
  row, range handles stay grabbable when a range is narrow, and the timeline's tick labels no longer collide.

- [#370](https://github.com/osbytes/reelsaw/pull/370) [`a0be6a6`](https://github.com/osbytes/reelsaw/commit/a0be6a6d3167dd8fafc37564c2b6aeb2592fc9e4) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Projects with ranges (and Most replayed peaks) download again behind an `https://` download proxy: the parts of the video are now fetched through the same proxy as the rest of the download instead of straight from the server, which the site refused. When no configured proxy can fetch parts of a video, the project says so instead of "the site blocked the download".

## 0.51.0

### Minor Changes

- [#365](https://github.com/osbytes/reelsaw/pull/365) [`36910ab`](https://github.com/osbytes/reelsaw/commit/36910abfbd292abfcb66bf5d3363aaea79e98bca) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Reelsaw is ready for other languages. Every string a person reads now comes from a message catalogue: the web app, the server's errors (each with a stable code and its parameters beside the sentence), notices, emails, MCP results, CLI lines and reelsaw.com. Numbers, sizes, amounts and dates are formatted for the reader's locale. Each account can choose its language and time zone under Settings → Account → Language and region, with `get_locale_preferences` / `set_locale_preferences` over MCP, or with `reelsaw locale-prefs <email>`; emails are written in the recipient's language, with dates in their time zone. English is the only language that ships today, and a translation is a pull request to the catalogues (docs/I18N.md).

- [#366](https://github.com/osbytes/reelsaw/pull/366) [`ea41f38`](https://github.com/osbytes/reelsaw/commit/ea41f385297c950d3e61eefaa41b5ab0d1b73923) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clip only the parts of a long video that matter. New project draws the video's length as a timeline before anything downloads: pick ranges on it (click, drag or type), take YouTube's Most replayed peaks as suggestions, and set each range to find clips inside it or to be the clip. Pipelines send the same ranges with `create_project { ranges, rangesFrom }`, `check_source` prices them, and `reelsaw create-project --range … --most-replayed n` does it from the CLI. Only the ranges are downloaded, transcribed, picked from and counted against minutes; each range's `ref` comes back on its clips, `get_project` and the `clip.done` / `clip.failed` webhooks. The project page shows the ranges with their clips and adds more (`extend_project { ranges }`), counting only new time.

### Patch Changes

- [#368](https://github.com/osbytes/reelsaw/pull/368) [`ab155fc`](https://github.com/osbytes/reelsaw/commit/ab155fc4a557208cb9b6d1935b0c50dbd6427869) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Fixes from a project audit. A link that streams with no announced size can no longer fill the disk: every yt-dlp download now stops once its file passes `MAX_SOURCE_FILE_MB`. Ranges added to a partly processed project past its processed start now give clips inside those ranges, not clips that end before they start, and a later "Clip the rest" counts only minutes not already counted for those ranges. Re-picking a project no longer makes a second clip for an exact range whose clip you edited. Error reports to Sentry leave out the visitor's address, request headers, cookies and bodies. Clips and zips taken through share links now count as downloads in product analytics. The hourly new-project count no longer counts an extension as a new project. Retrying plan refusals after an upgrade waits until a whole transcription chunk fits. A forged page link gets a clear error instead of a server error. The README, CLI reference, research notes and website now cover range clipping, output shapes, OpenCode and non-English videos.

## 0.50.0

### Minor Changes

- [#363](https://github.com/osbytes/reelsaw/pull/363) [`4eefcef`](https://github.com/osbytes/reelsaw/commit/4eefcef21df2522d4901c82e62e990a63d2e2488) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Lists share one search, filter and sort bar. Users, Projects and Templates now have a search box, a single Filter menu, Group (Users) and Sort, with the number of matches and the filters in force shown above the list; the next page loads as you scroll. Projects can be searched by title, filtered by status and sorted by date, title or length, and Templates searched and sorted, in the app, through `list_projects` / `list_layer_templates`, and with `reelsaw templates list --q --sort`. Searching for a whole email address now finds just that account instead of everyone at the same domain.

### Patch Changes

- [#362](https://github.com/osbytes/reelsaw/pull/362) [`8980853`](https://github.com/osbytes/reelsaw/commit/89808539577bccbd8046f1f393b8a15269d7fe18) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Hosted plans bound how much of a machine one account's jobs hold at once: Free 2 cores and 2400 MB, Starter 4 / 4800, Creator 6 / 7200, Pro 8 / 9600. A scan past the ceiling runs with fewer threads; a render past it goes back to the queue until the account's other work ends, so it never holds a worker slot while another account's render waits; it is not counted as a failed attempt, moves up its queue as it waits, and gets past the paid reserve after a few minutes at most, so busy paid work delays a Free render but never starves it. The project shows the wait and, where a plan would help, an upgrade offer. `FREE_RESERVE_CORES` keeps the last cores of each machine for paid plans. Admins can override an account's ceiling in Users → Limits, `reelsaw limits <email> --cores N --mem-mb M` or `set_user_resources`. Self-hosted instances are unchanged: the host's capacity is the only limit.

- [#360](https://github.com/osbytes/reelsaw/pull/360) [`8781e85`](https://github.com/osbytes/reelsaw/commit/8781e85cb33d96a36e61d14617eb5e6a3bf6e9d3) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The shot-cut scan decodes with up to 4 threads instead of one, about 3x faster on CPU-only hosts with the same cuts. Cores, memory and disk are now leased from one shared ledger per host (`resource_leases`): every video ffmpeg pass takes its threads from a lease, render encodes share the host's cores across every worker process on it, and a render leases its memory, so parallel scans, renders and worker replicas no longer over-commit the machine. Settings → System → Workers, `list_workers` and `reelsaw workers` show the leased cores and memory. `SCENE_SCAN_THREADS` pins the scan's thread count.

## 0.49.1

### Patch Changes

- [#351](https://github.com/osbytes/reelsaw/pull/351) [`b3ba812`](https://github.com/osbytes/reelsaw/commit/b3ba8120d40f162570d113c56c0af6e4025d1ff4) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Every MCP tool now tells clients whether it only reads, adds something, or can replace or remove data. 23 tools had no annotations, so clients had to assume each one might destroy data: `create_project`, `create_clip`, `add_asset`, `retry_project` and the other additive tools now say they are not destructive, and `reanalyze_project` and `add_transcript_cut` say they are. The web app also honours your system's reduced-motion setting everywhere: transitions and animations end at once, and loading spinners keep turning.

## 0.49.0

### Minor Changes

- [#341](https://github.com/osbytes/reelsaw/pull/341) [`44de38c`](https://github.com/osbytes/reelsaw/commit/44de38cd3da44d32b75782a8554f6c15fcdcf94a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Follow the person who is talking in two-person shots with a learned audio-visual model (LR-ASD, 3.4 MB, on the CPU) instead of mouth motion alone. A listener who laughs, smiles or drinks is no longer taken for the talker, and when only one person is on camera an off-camera interviewer's turns are recognised. A sign or poster the face detector mistakes for a face no longer makes a two-shot look like three people. The previous heuristic remains as the fallback (`ASD_MODEL=false`, or when the model files are missing); `reelsaw machine` and Settings → System show which one runs.

- [#340](https://github.com/osbytes/reelsaw/pull/340) [`f97fda2`](https://github.com/osbytes/reelsaw/commit/f97fda28a98a83ce1042c133108c86b778fb774f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Shots without a face no longer always show the whole frame. When one thing in the shot clearly moves (b-roll of a ship or a car, a product turned in the hand, a worker at a machine), automatic framing crops to 9:16 and follows it, holding the crop still when the subject stays put and panning with the same tripod smoothing as the speaker crop when it moves. The motion comes from the frames the face detector already decodes, with the camera's own pan taken out, so it costs no extra model. Anything less clear stays whole: motion spread across the frame (crowds, water, 3D gameplay), no motion, a subject wider than the crop, text the crop would cut, or a shot under two seconds. The editor labels these pieces "Follow subject", and `get_clip` reports them as `center` layout segments with `focus: "subject"` and their crop track.

- [#345](https://github.com/osbytes/reelsaw/pull/345) [`a6a6795`](https://github.com/osbytes/reelsaw/commit/a6a67950bed2a166cb163142dffeee4cc4468e09) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clips can now render as 4:5, 1:1 or 16:9 as well as 9:16: pick the Shape in the editor's Captions tab, for one clip or all of them, or set `shape` with `update_clip` / `update_project_style` (`reelsaw update-style --set shape=1:1`). Framing follows the shape: the speaker crop is a window of that shape, split and stack stay two stacked panes in 4:5 and 1:1 and show the whole frame in 16:9, so a 16:9 source comes out as itself. Captions keep their size and position, the editor previews the clip at its shape, and a 16:9 clip's export text drops `#Shorts`.

- [#343](https://github.com/osbytes/reelsaw/pull/343) [`9cf4b5d`](https://github.com/osbytes/reelsaw/commit/9cf4b5d734f88a27d8ebe2d23bf3fdc0a21f511f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Punch-in zooms: turn on "Zoom in on key words" in the editor's Captions tab (or `punchIn` in `update_clip` / `update_project_style`, `reelsaw update-style --set punchIn=true`) and the picture eases in briefly on each key word, by 1.05-1.3x (default 1.12x). Zooms happen on face and centre crops and on a phone inset that fills the frame, never on split or stack panes and never across a cut or a change of framing. Off by default, so existing clips re-render unchanged. The editor preview zooms the same way, and `get_clip` lists the zooms the last render burned in.

- [#342](https://github.com/osbytes/reelsaw/pull/342) [`9b2ce15`](https://github.com/osbytes/reelsaw/commit/9b2ce1516dfdd30b1be78426f789d7cced9ba539) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Reframing runs on a stronger face detector: YuNet (MIT, 230 KB, with five landmarks per face) replaces UltraFace, at the source's own shape and about 640x360 pixels instead of a squashed 320x240. It finds small webcam faces in meeting recordings, wide-shot faces and vertical-video faces UltraFace missed, and no longer boxes round pans and other cookware as faces. Each face now keeps an identity across frames, so a split keeps each speaker on their own face when a hand or a second detection appears beside them, and a poster is still dropped when someone walks past it. Self-hosted installs outside Docker: run `pnpm models:download` to fetch `yunet-2026may.onnx`, and update `FACE_MODEL_PATH` if you set it by hand.

### Patch Changes

- [#346](https://github.com/osbytes/reelsaw/pull/346) [`a6d2915`](https://github.com/osbytes/reelsaw/commit/a6d2915f0e0bebd434a5248a1e104821d6a74531) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clip selection scores every candidate. With a small self-hosted judge (such as qwen2.5:14b in Ollama), about a third of the moments found used to come back without a score and were ranked below all the others, and many of the rest got the same total (68) because the judge copied the prompt's example. The judge now gets an example with no numbers in it, any candidate it leaves out is asked about again on its own, and extra score samples read each batch in a different order.

## 0.48.0

### Minor Changes

- [#338](https://github.com/osbytes/reelsaw/pull/338) [`38078e4`](https://github.com/osbytes/reelsaw/commit/38078e46f3781c1abf93e4771aef701b6b20db3b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Phone footage edited into a 16:9 video between blurred or black bars is now cropped to the picture itself. A vertical clip fills the 9:16 frame instead of showing the whole frame, bars and all, at a third of the width; a square or 4:3 inset is shown at its own shape over a blurred copy of itself. Automatic framing only: "Whole frame" still shows the whole frame, and a crop set on the section wins. The editor labels these pieces "Inset video", and `get_clip` reports the crop as `inset` on the layout segment.

- [#347](https://github.com/osbytes/reelsaw/pull/347) [`8151f8d`](https://github.com/osbytes/reelsaw/commit/8151f8d31d33ad227b2ecd5f1e5cec6912d4efef) Thanks [@adavila0703](https://github.com/adavila0703)! - OpenCode is a model provider. Paste one OpenCode Console key under Settings → Models (or set `OPENCODE_API_KEY`) and the picker lists both plans as sections of one card: pay-per-token Zen models as `opencode:<model>` and, if the key has a Go subscription, Go models as `opencode-go:<model>`. The prefix records which plan pays. Reelsaw talks to OpenCode over Chat Completions, so the picker shows the paid chat models OpenCode itself lists as served natively on Chat Completions (Kimi, GLM, DeepSeek and others); models it serves on other APIs lose structured output in translation and are left out, decided from OpenCode's listing, not from model names. Go is meant for coding agents and caps any 5 hours at 20% of the month, so its section says so; Reelsaw sends Go its own user agent and one `x-opencode-session` per project, as OpenCode asks. Language models only: keep a transcription provider for speech. The same listing is in `list_models` and `reelsaw models --provider opencode`.
  
  Structured output to OpenAI-compatible servers (the compat server, OpenCode) now asks for lenient JSON schemas like OpenAI already did, so models behind them no longer reject schemas with optional fields. A stage that times out now suggests the remedy that fits a cloud model too.

### Patch Changes

- [#344](https://github.com/osbytes/reelsaw/pull/344) [`d8365d2`](https://github.com/osbytes/reelsaw/commit/d8365d2a41fb4a64da23741566b3e789fc1662be) Thanks [@adavila0703](https://github.com/adavila0703)! - The Settings → Models picker no longer lags when you click a provider. A self-hosted Speaches server lists hundreds of downloadable models, and the picker used to draw all of them at once; it now shows the first 50 per provider, loads more as you scroll ("Showing 50 of 729"), and searches every provider on the server as you type. The models in use always come first. The same listing is the new MCP tool `list_models` and the `reelsaw models` command.

## 0.47.1

### Patch Changes

- [#327](https://github.com/osbytes/reelsaw/pull/327) [`c142656`](https://github.com/osbytes/reelsaw/commit/c142656da96bd582a24aac18dfc5e42f93496153) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Captions in Hindi, Bengali, Thai, Japanese, Chinese, Korean, Tamil, Georgian and the other scripts the transcription model takes no longer burn in as empty boxes: the image now carries Noto fonts for each of them, and captions in any font, uploaded ones included, fall back to them for characters the font lacks. The image is about 130 MB larger unpacked.

- [#327](https://github.com/osbytes/reelsaw/pull/327) [`ad55d86`](https://github.com/osbytes/reelsaw/commit/ad55d861154c848168a0be6c2362af3b78d8b577) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clip titles, hooks, captions and hashtags are written in the video's language. The prompts that find clips and write their packaging are in English and did not say which language to answer in, so a Spanish or German video often came back with English titles and on-screen hooks. Prompts for English videos, and for videos whose language was not detected, are unchanged.

- [#327](https://github.com/osbytes/reelsaw/pull/327) [`7010dc4`](https://github.com/osbytes/reelsaw/commit/7010dc4fe95e5fcec179393636f7d5e5e5a35a7d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Reelsaw now knows what each spoken language needs and says what it cannot do for it yet. The language picker, `list_languages` and `reelsaw languages` show each language's gaps (for example "captions: no font on this server draws Devanagari", or that filler removal is English only), the activity feed repeats them once the transcript is in, and a render that draws characters no font has says so instead of burning in empty boxes. Captions in Japanese, Chinese and Thai no longer get spaces between their words and break lines by the width of the text, Arabic and Hebrew captions are laid out right to left, hooks use the language's own capitals (Turkish İ) or stay as written in scripts without capitals, and subtitle files in Thai or Japanese are split into words by dictionary.

- [#327](https://github.com/osbytes/reelsaw/pull/327) [`df815a4`](https://github.com/osbytes/reelsaw/commit/df815a4fa76355c7a620a0a2e7b0723426a77a81) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The spoken language picker lists the languages the transcription model in force takes: a self-hosted server (Speaches) and Deepgram say which, and Whisper's own set is assumed for the rest. New `list_languages` tool and `reelsaw languages` command. Language codes are canonicalised with the standard aliases ("iw" is Hebrew, "jw" Javanese), and a misspelt language is now left to detection instead of being sent to the model.

- [#327](https://github.com/osbytes/reelsaw/pull/327) [`7e5893f`](https://github.com/osbytes/reelsaw/commit/7e5893fde4b655930b46687527ebf32ae71c080f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clips start and end on sentences in every language: the full stops of every script count ("।" in Hindi, "。" in Japanese, "؟" in Arabic), where before only ". ! ?" did, so a Hindi transcript with its full stops now puts nearly every clip edge on a sentence. A transcript without punctuation (most transcription models return Hindi without it) is split into sentences on its speaker's pauses instead of every 28 words, the English rules for capitals and "and"/"so" no longer apply to other languages, and the activity feed says when clip edges had only pauses to go on.

- [#327](https://github.com/osbytes/reelsaw/pull/327) [`1dd1081`](https://github.com/osbytes/reelsaw/commit/1dd10819e8166c9885c15f082df073910c50afcc) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The spoken language is a searchable list of the languages the transcriber knows, by name and by each language's own name ("German", "Deutsch"), in Project defaults and under Advanced when you start a project. It used to be a free-text box in Project defaults only, where "Englsh" or "pt-br" was saved as typed. The names come from the browser and the server's own language data, not from a list kept in Reelsaw, and the server reads a language a model reports by name ("german") through the same list.
  
  On New project, "Detect automatically" (and any optional setting you empty there) now overrides your project defaults instead of being filled back in from them; create_project and `reelsaw create-project` take the same `clear` list as an update.

- [#327](https://github.com/osbytes/reelsaw/pull/327) [`85da77e`](https://github.com/osbytes/reelsaw/commit/85da77e52d2bf032893bd1a8079a21c5fcf6aa98) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The spoken language in a project's settings (or your project defaults) is now sent to the transcription model instead of being ignored. Every model auto-detected the language before, so a video that opened with music or a greeting in another language could be transcribed, or translated, in the wrong language, and the filler, name and cut steps were then turned on or off for the wrong language. The clip cut search transcribes in the same language, and a transcript's language is always saved as a code ("en"), not the name some models answer with ("english").
   Because the cut search now names the language, the first re-render or exact preview of an existing project transcribes its cut windows again (once). Imported subtitles take the project's language when the file has none, and chunks transcribed before the language was changed are transcribed again on a retry instead of being reused.

## 0.47.0

### Minor Changes

- [#332](https://github.com/osbytes/reelsaw/pull/332) [`5a4f9fb`](https://github.com/osbytes/reelsaw/commit/5a4f9fbeb339272fc78f2f2773d565b8780ccfce) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clips sound even and end cleanly. Every clip's speech is now brought to −14 LUFS (the level TikTok, Reels and Shorts play at) and the finished mix goes through a peak limiter, so clips no longer range from whisper-quiet to clipping. Pause trimming only cuts quiet gaps: game sound, music or laughter between lines stays, and a clip that is mostly sound without speech (gameplay, trailers) keeps its timing instead of shrinking to a few seconds; the clip's Cuts tab says why. A clip's ending no longer takes along the first words of the next sentence, clips of one project no longer share a title, text printed on a shirt in a multi-camera video is no longer blurred as if it were subtitles, and a render stopped by the server (for example running out of memory) says so instead of "exited with null".

- [#324](https://github.com/osbytes/reelsaw/pull/324) [`663dd68`](https://github.com/osbytes/reelsaw/commit/663dd686477bf36f54af75aee944d740b6b9c083) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A video longer than your minutes cover is no longer refused. Reelsaw clips the start your minutes cover (on Free, a long first video gets its first 60 minutes), and the project shows how much is left. "Clip the rest" (also `extend_project` and `reelsaw extend-project`) processes more when you have the minutes, and upgrading does it for you. It picks up where it stopped: your clips, transcript fixes and decisions stay, and new clips come only from the new part. Upgrading also re-renders your watermarked clips without the watermark, and Download on a watermarked clip now offers that first. Sign-ups now record where they came from, even when the confirmation email is opened in another browser.

## 0.46.0

### Minor Changes

- [#322](https://github.com/osbytes/reelsaw/pull/322) [`b40f202`](https://github.com/osbytes/reelsaw/commit/b40f2020e31eaf1e264dd93605da7766c279fa11) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The MCP server now speaks the 2026-07-28 protocol as well as the 2025 revisions. Agents and clients on the new protocol were refused with "Unsupported protocol version"; they now connect to `/api/mcp` and to `reelsaw mcp` (stdio) like older clients do.

### Patch Changes

- [#321](https://github.com/osbytes/reelsaw/pull/321) [`1262eea`](https://github.com/osbytes/reelsaw/commit/1262eea0675780370b480a953056f7041bac5e0a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - An audio file with cover art (a podcast episode, a music track) now makes clips with the art as the picture. Before, every clip of such a source came out as sound alone and failed on its thumbnail, retry after retry. A file with sound and no picture at all is now refused when it is added, with a message saying what to upload instead, rather than failing later at render.

- [#323](https://github.com/osbytes/reelsaw/pull/323) [`23085df`](https://github.com/osbytes/reelsaw/commit/23085df2dc6a3a6c9a2e332452fe1ebac0d87e25) Thanks [@dillonstreator](https://github.com/dillonstreator)! - An upload cut off by the browser or the network (a dropped connection, a closed tab) is now logged as a warning, "upload aborted by the client", instead of an error, so it no longer shows up as an error report.

- [#325](https://github.com/osbytes/reelsaw/pull/325) [`bd02f65`](https://github.com/osbytes/reelsaw/commit/bd02f65c1361132d01c3a706178543df1be96974) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The container gives the app a writable home directory. It used to keep root's, which the app's user cannot write, so every ffmpeg run that drew captions printed a "Fontconfig error: No writable cache directories" line per font lookup, filling the start of render error messages and hiding the real cause, and yt-dlp could not keep its cache between downloads.

## 0.45.3

### Patch Changes

- [#318](https://github.com/osbytes/reelsaw/pull/318) [`1941668`](https://github.com/osbytes/reelsaw/commit/1941668728b4eaabb43df20949e71041e1cb2e41) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Security: the image runs on Node 24.22.3, which fixes the Node.js vulnerabilities reported against 24.22.1.

## 0.45.2

### Patch Changes

- [#316](https://github.com/osbytes/reelsaw/pull/316) [`cb75e77`](https://github.com/osbytes/reelsaw/commit/cb75e77fd38219875dfdc33a9ed6397d8e7da175) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A link pasted into reelsaw.com's hero box now carries through sign-up: after your first sign-in, New project opens with it already pasted.

## 0.45.1

### Patch Changes

- [#313](https://github.com/osbytes/reelsaw/pull/313) [`1ffe218`](https://github.com/osbytes/reelsaw/commit/1ffe2183d61cd14bfb4667187d0e6015e8daa770) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A link to a stream that has just ended is refused instead of downloading for hours. YouTube lists such a stream as still being processed (`post_live`) and reports no length for it, so the live-stream refusal let it through and the minutes limit could not be checked before the download. Its recording then came down fragment by fragment, a day-long stream in hours, while holding an ingest slot. It is now refused like a live stream, with a message to add it again once the recording is up.
  
  A download whose size is not known up front (a fragmented recording) is stopped once what has arrived passes `MAX_SOURCE_FILE_MB`. `--max-filesize` only refuses a size yt-dlp knows before it starts.
  
  The live-stream lookup and the download filter now come from one table of every status yt-dlp reports, and CI checks the filter against the pinned yt-dlp for each status, a direct file link and an unknown value, so a direct `.mp4` link keeps downloading.

## 0.45.0

### Minor Changes

- [#310](https://github.com/osbytes/reelsaw/pull/310) [`f261c7f`](https://github.com/osbytes/reelsaw/commit/f261c7f1b6e78e23c6b4f288bfd9c9dad0a8013c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Queue visibility and priority: Settings → System → Queue (`reelsaw queue`, `get_queue`) shows how long jobs waited to be picked up in the last hour per stage (median and 95th percentile), which accounts have work queued and at what priority, and waiting jobs in the order workers take them. Admins can set an account's queue priority (Users → Limits, `reelsaw limits <email> --priority N`, `set_user_queue_priority`), and on hosted plans every paid plan now starts jobs ahead of Free (Starter +2, Creator +3, Pro +5).

### Patch Changes

- [#312](https://github.com/osbytes/reelsaw/pull/312) [`b67f90b`](https://github.com/osbytes/reelsaw/commit/b67f90b9cc96ae5207da0704f1454e0b9038a48c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A long link download no longer crashes the server. Ingest buffered yt-dlp's whole stdout, which now carries a progress line per tick; on a long enough download the buffer passed Node's string limit and the uncaught `RangeError` took the process down (the app and its workers), and the reconciler re-queued the same project into the same crash. Commands now keep only bounded output: a caller that reads lines keeps what it needs, and anything else that writes too much is stopped with an error instead of crashing.
  
  When yt-dlp gives up on the full-quality download of a clip's window because of a bot check or a refused page, the clip renders from the preview copy right away instead of retrying into the same block and failing, and the project's other clips go straight to the preview copy for the next half hour instead of each trying again. Rate limits and expired media links still retry. Downloads that do not read yt-dlp's progress no longer ask for it, and command output is decoded across chunk boundaries, so non-Latin titles are no longer garbled.
  
  Frame sampling (face tracking, on-screen text, speaker detection) no longer fails now and then with `ff_frame_thread_encoder_init`: the single-thread setting reached only the decoder, not the rawvideo encoder.

## 0.44.0

### Minor Changes

- [#307](https://github.com/osbytes/reelsaw/pull/307) [`303f119`](https://github.com/osbytes/reelsaw/commit/303f119cd6a0acfd40ca2715e72f13370befc7ff) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Pick the caption font in the app. The editor's Style tab has a Font picker for captions and the hook, for one clip or the whole project, and Project defaults has one for new projects. Admins set the instance's default font under Settings → System → Captions without a restart (`CAPTION_FONT` is now a runtime setting) and can upload `.ttf`, `.otf`, `.woff` or `.woff2` files there, which every account can then pick for captions, hooks and text layers. The watermark always uses the instance's font. A font that is no longer available falls back to the instance font and then DejaVu Sans. The same works through `list_fonts`, `add_font`, `remove_fonts`, `style.font` on `update_project_style` / `update_clip` / `set_project_defaults`, and `reelsaw fonts`.

### Patch Changes

- [#308](https://github.com/osbytes/reelsaw/pull/308) [`2d70bc3`](https://github.com/osbytes/reelsaw/commit/2d70bc3e706b24a06f19d40d395a88e1eb3dc0da) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Polish from a walk through the whole app. Browser tabs now name the page ("Budgeting talk · Reelsaw"), so several
  open projects can be told apart. While a project is still running, its header no longer shows a green "Transcript
  updated" as if it were done; it keeps showing the stage at work. The ⌘K palette shows each project's current status
  instead of one from up to half a minute ago. Deleting a clip happens at once with Undo (the editor still asks when
  unsaved edits would be lost), and Undo puts it back under its own number instead of at the end. Deep links into
  Settings highlight the right section, sideways-scrolling tab rows fade at the edge that has more, opening a project
  or the editor shows one loading skeleton instead of two, and "Resume following" on the transcript only appears when
  the playhead's line is off screen.
  
  Also: uploaded videos get a poster frame on the project page and its tile; ⌘K ranks a match in an action's name above
  one in its description and, on a project page, offers that project's actions first; a re-render of one clip reports
  "Re-rendered 1 clip in 0:25 · 3 ready"; deleting a selection of clips uses Undo instead of a dialog; empty lists show
  one "New …" button; list counts read "3 projects" instead of "Showing 3 of 3"; the clip menu is grouped; the editor's
  Cuts tab links to the clip's words in the transcript; the transcript toolbar no longer grows a row when the first fix
  lands; buttons show a spinner instead of "…" while they work. The first ⌘K open shows its box at once (a quick second click used to close it again),
  a project whose clips were all deleted says so and offers to restore them, and the transcript's selection bar no
  longer hangs off the panel's edge.

- [#307](https://github.com/osbytes/reelsaw/pull/307) [`4ff416b`](https://github.com/osbytes/reelsaw/commit/4ff416b59b34c4a7e010b8348ad97ed8199ff032) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The watermark text can be left empty for a logo-only watermark: clear Watermark text under Settings → System → Limits (or `reelsaw settings set WATERMARK_TEXT=`).

## 0.43.0

### Minor Changes

- [#303](https://github.com/osbytes/reelsaw/pull/303) [`dd45d48`](https://github.com/osbytes/reelsaw/commit/dd45d48362b540ca59c1c95625e0b2ef452bf872) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Cancelling a plan is clearer about what happens next. The Billing page shows the day the plan ends, also when the cancellation was set for a date in Stripe rather than the end of the period, and lists the Free limits the account will be over then (storage, projects, this month's minutes) with what each will refuse. The same list is in `get_billing` (`afterCancel`) and in a "your plan ends on …" mail sent when the cancellation is scheduled; a second mail says when the account has moved to Free. The `billing.canceled` event now fires once, when the subscription ends; scheduling a cancellation is `billing.cancel_scheduled`, and taking it back is `billing.cancel_undone`.
  
  Counts, sizes and dates read the same everywhere: the CLI, MCP answers and the app say "1 clip" and "3 clips" instead of "clip(s)", and sizes use one format (binary units, so a model download shows 4.4 GB where it used to show 4.7 GB).

### Patch Changes

- [#301](https://github.com/osbytes/reelsaw/pull/301) [`0fcb639`](https://github.com/osbytes/reelsaw/commit/0fcb639b51e567512c02979f5121f1545668541c) Thanks [@WaveHost77](https://github.com/WaveHost77)! - Direct links to a video file (a plain `.mp4` URL) download again instead of being refused as a live stream. Live and not-yet-started streams are still refused.

- [#305](https://github.com/osbytes/reelsaw/pull/305) [`9eddc3b`](https://github.com/osbytes/reelsaw/commit/9eddc3b47f236beee22845a6fb133ca8501d6484) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Errors thrown by browser extensions (wallets, password managers) no longer reach the app's error reports.

- [#306](https://github.com/osbytes/reelsaw/pull/306) [`8cd789e`](https://github.com/osbytes/reelsaw/commit/8cd789ee02b491548468ba7a66727486b0380b62) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `LLM_TRACE=langfuse` sends traces again: Langfuse Cloud stopped accepting traces from the old SDK, so model calls and decision scores now go through Langfuse's current OpenTelemetry SDK. A self-hosted Langfuse needs version 4.59.0 or later.

## 0.42.0

### Minor Changes

- [#298](https://github.com/osbytes/reelsaw/pull/298) [`17e5fea`](https://github.com/osbytes/reelsaw/commit/17e5fea44ab26f310f77bea13f2402d513682fe2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Failed work under Settings → System → Queue now says why each item failed: a platform fault (disk, model, encoder, timeout) that a Retry fixes after the platform is repaired, a source problem (a dead or private link, no audio, no usable clips) that fails the same way again, or a plan limit. Admins can dismiss failures nobody will retry, one at a time or every match of a filter, and bring them back from Show dismissed. Dismissing only clears the admin list: the owner's project keeps its error and its own Retry. Retry matching now retries platform failures unless you pick another cause. Videos refused for a plan limit in the last 30 days are retried automatically when the owner subscribes, changes plan or has their limits raised. The same actions are available as the `dismiss_failures` MCP tool, a `cause` filter on `list_failures` and `retry_failures`, and the `reelsaw dismiss-failures` and `reelsaw retry-failures --cause` commands.

### Patch Changes

- [#297](https://github.com/osbytes/reelsaw/pull/297) [`ddf5f67`](https://github.com/osbytes/reelsaw/commit/ddf5f67dc08fd82019d4339aab26ca2da9d08765) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Sorting the admin Users list by a column now sorts every matching account on the server. Before, a column header reordered only the rows already loaded, so "Stored, biggest first" showed the biggest of the first 50 accounts, not the biggest overall. Sorting works with search, filters and grouping, and pages with "Load more". The sort is in the page link (`#sort=storedBytes&dir=desc`). Agents and operators get the same order: `list_users` takes `sort` and `dir`, and `reelsaw users` takes `--sort` and `--dir`.

## 0.41.0

### Minor Changes

- [#295](https://github.com/osbytes/reelsaw/pull/295) [`ba20e27`](https://github.com/osbytes/reelsaw/commit/ba20e27d19770edd6518626b37d1d749f576741b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - New per-account limit `MAX_MANUAL_CLIPS_PER_USER`: how many clips an account may add from its own time ranges, deleted ones included (0 = unlimited, the default). Past it, `create_clip`, the editor and `reelsaw create-clip` explain the limit and offer the plan that lifts it. Quota refusals in the web now show their sentence next to the offer's button instead of repeating the link in the text.

- [#295](https://github.com/osbytes/reelsaw/pull/295) [`ba20e27`](https://github.com/osbytes/reelsaw/commit/ba20e27d19770edd6518626b37d1d749f576741b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Plans can set the resolution a link is downloaded at (`sourceHeight` in the plan list). On a capped plan the project keeps a small preview of the video for transcription, analysis and the editor, with the full audio. Each clip renders from a full-quality window of the video fetched for it. Nearby clips share one window, a window is reused by every re-render that fits inside it, and a clip edited past its window fetches only the missing stretch. Windows are placed on the source's clock by matching their audio to the preview, so captions and cuts line up as before. The project page and the clip editor mark a preview source and name the plan that downloads at full quality. `get_project` reports `sourcePreviewHeight`. Window downloads are fetched by ffmpeg, which supports HTTP proxies only; see Troubleshooting for `YTDLP_PROXY`.

### Patch Changes

- [#296](https://github.com/osbytes/reelsaw/pull/296) [`7a3dd2e`](https://github.com/osbytes/reelsaw/commit/7a3dd2e43c6b6ed81c497a9c14976a08ba5a1506) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Links to a live stream, or a stream that has not started yet, are now refused with a message saying to add the link again once the recording is up. Before, ingest recorded the stream through the download proxy until the stream ended, which could take hours and use up proxy traffic. The project sat in ingest with no progress. The recording of a stream that has ended downloads as before. Accounts with a minutes limit see the refusal as soon as they check the link or create the project (check_source, the New project form). Every other account sees it when ingest starts, before anything is downloaded.

- [#295](https://github.com/osbytes/reelsaw/pull/295) [`ba20e27`](https://github.com/osbytes/reelsaw/commit/ba20e27d19770edd6518626b37d1d749f576741b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `reelsaw scenario` sets up a project in a known state in a few seconds, for screenshots and UI review, with no download or model run: a preview source, a used manual-clip allowance, a window that could not be fetched, a full-quality source, or a failed link. It runs only on a local instance (docs/UI.md).

- [#293](https://github.com/osbytes/reelsaw/pull/293) [`b88e89b`](https://github.com/osbytes/reelsaw/commit/b88e89bfb7d02c9ebf8a992b1f0fb5592cf16ff4) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Settings → Share links no longer grows without end. The list scrolls inside its card, and a new Clear button deletes revoked and expired links (also `clear_media_links` in MCP and `reelsaw media-links clear <email>`). Before, those links stayed listed for `MEDIA_LINK_RETENTION_DAYS` after they stopped working. Links of a deleted project or clip now show as "In trash" instead of "Active". They have not worked since the delete, and restoring the project brings them back. You can still revoke them so a restore keeps them off. Other Settings lists that grow with use (a webhook's deliveries, API keys) now scroll at the same height.

## 0.40.2

### Patch Changes

- [#292](https://github.com/osbytes/reelsaw/pull/292) [`cb3f4d6`](https://github.com/osbytes/reelsaw/commit/cb3f4d64dff60a5c2b47ad7a4737bf38446844eb) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Groq transcription models (`groq:whisper-large-v3`, `groq:whisper-large-v3-turbo`) pass the boot word-timestamp check again, and cuts and captions on them get per-word timing instead of times spread over each phrase. Reelsaw asked Groq for word and segment timestamps, and the provider package keeps the segments and drops the words when an answer has both. Reelsaw now asks Groq for words only, and reads words before segments from OpenAI and Groq answers whatever they contain, as it already did for OpenAI-compatible servers. Stored word-timestamp results now record the request that made them, so a model refused under the old request is tested again at the next boot instead of staying refused for 30 days.

- [#289](https://github.com/osbytes/reelsaw/pull/289) [`f9157bd`](https://github.com/osbytes/reelsaw/commit/f9157bdffddf9ae22b2a22f4971a45602e02a646) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Creating a project from a link is quicker on accounts with a monthly minutes limit. The video's length was looked up with yt-dlp when the link was checked, again when the project was created and again before the download; a link's length is now looked up once and reused for ten minutes, so Create no longer waits on a second lookup. A lookup that fails is not kept, and the limit is still enforced on the downloaded file.

## 0.40.1

### Patch Changes

- [#284](https://github.com/osbytes/reelsaw/pull/284) [`9c8f3a3`](https://github.com/osbytes/reelsaw/commit/9c8f3a324d0c1b0ad01a9d30190d1e3540df664e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Signing up for the Free plan from the website now lands on a new project instead of the Billing page, where there was nothing to buy. Analytics for self-hosted instances with PostHog: a signed-out visit no longer resets the anonymous visitor, so the UTM tags a visitor arrived with stay on their sign-up and later events.

- [#284](https://github.com/osbytes/reelsaw/pull/284) [`2ea20cd`](https://github.com/osbytes/reelsaw/commit/2ea20cd5bb640c1725bf99d4bdc188a7558f2ede) Thanks [@dillonstreator](https://github.com/dillonstreator)! - On Railway, the server now warns at boot when `TRUSTED_PROXY_HEADER` is left on `x-forwarded-for`. Railway's edge puts the visitor's address in `X-Real-IP`, so read from `X-Forwarded-For` every sign-up shares one address, which floods the `shared_ip` abuse flag and makes the per-address sign-up cap meaningless. The configuration docs and README now say to set `TRUSTED_PROXY_HEADER=x-real-ip` there.

## 0.40.0

### Minor Changes

- [#282](https://github.com/osbytes/reelsaw/pull/282) [`4d06d5b`](https://github.com/osbytes/reelsaw/commit/4d06d5bd089367957c2468c94ea17cc96af2a4fb) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Select several projects on the Projects page and act on them at once: a compact bar retries the failed ones, re-renders their clips or deletes them (restorable, with Undo), each after a confirmation. New MCP tools `delete_projects`, `retry_projects` and `rerender_projects`, and CLI `reelsaw delete-projects`, `retry-projects` and `rerender-projects`. Group actions now show that they are running everywhere: confirm dialogs keep a spinner until the work is done (and show a failure in place), selection bars show a spinner while their action runs, and actions started from a menu or ⌘K show a loading toast that turns into the result.

## 0.39.1

### Patch Changes

- [#280](https://github.com/osbytes/reelsaw/pull/280) [`6d72e88`](https://github.com/osbytes/reelsaw/commit/6d72e88cf4ee68d0758db63279b60e65547341ee) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Name fixes no longer change everyday words in captions on their own. Everyday words now come from a standard English dictionary list (SCOWL), so contractions ("don't", "you're"), casual spellings ("gonna") and word forms like "noticing" or "heard" count as everyday words, so a suggested name in their place waits for your review instead of being applied.

## 0.39.0

### Minor Changes

- [#278](https://github.com/osbytes/reelsaw/pull/278) [`973f5d5`](https://github.com/osbytes/reelsaw/commit/973f5d54e959609f03d0933e046d197f4bc65dec) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The Users page now shows which accounts share a sign-up address. Grouped by flag, the shared ip and signup burst sections are split by address, busiest first, each with its own count, paging and "Select all", so you can review or suspend one address's accounts together. "Group by address" groups the whole list the same way, and "Only this address" narrows the page to one. Over MCP, `list_users` takes `groupBy: "ip"` and the `signupIp` and `sharedIp` filters (also in `manage_users`); on the box, `reelsaw users --group ip`, `--ip` and `--shared-ip`.

## 0.38.0

### Minor Changes

- [#276](https://github.com/osbytes/reelsaw/pull/276) [`4e0213a`](https://github.com/osbytes/reelsaw/commit/4e0213af17d7831202913f7c69caade387978eda) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can group the Users page by abuse flag. "Group by flag" splits the filtered list into sections (shared sign-up address, sign-up burst, temporary email domain, then the unflagged, folded), each with its count over every match, its own "Load more" and a header checkbox; "Select all 120" in a section takes every account in it, so a bulk suspend acts on exactly one reason. The other filters still apply, and the grouping stays in the link. The same sections are `groupBy: "flag"` in `list_users` (each with the filter to page it or pass to `manage_users`) and `reelsaw users --group flag`; `--in <section>` takes one section in `users` and `users-bulk`.

## 0.37.0

### Minor Changes

- [#274](https://github.com/osbytes/reelsaw/pull/274) [`7be0341`](https://github.com/osbytes/reelsaw/commit/7be0341ac2521140b3df25b75557f6f41602d04f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can filter the Users page by why an account was flagged: shared sign-up address, sign-up burst or temporary email domain. The new Flag filter shows how many accounts each reason covers, a flag chip on a row lists everyone flagged for that reason, and the choice stays in the link. Bulk actions on "every match" follow it, and the same filter is `flag` in `list_users` / `manage_users` and `--flag` in `reelsaw users` / `users-bulk`.

### Patch Changes

- [#273](https://github.com/osbytes/reelsaw/pull/273) [`e7511af`](https://github.com/osbytes/reelsaw/commit/e7511af1ba15f29debab3ad7cd0b4b334ad2b8fb) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Self-hosted instances that transcribe with a local OpenAI-compatible speech server through `OPENAI_BASE_URL` (Speaches in the local-ai setup) boot again. The word-timestamp check read the server's phrase-level segments instead of the per-word times it returns alongside them, judged the model unusable and stopped startup. A result stored by the old check is tested again at the next boot.

## 0.36.1

### Patch Changes

- [#271](https://github.com/osbytes/reelsaw/pull/271) [`812e5b3`](https://github.com/osbytes/reelsaw/commit/812e5b310fea26c553b00c98361c490fbb999849) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A zip export that you cancel, or that drops mid-download, now stops fetching the remaining clips and frees its temporary copies right away, instead of downloading every clip to the server and keeping them until the next day's cleanup. Cancelled exports are logged as cancelled rather than as failures.

## 0.36.0

### Minor Changes

- [#269](https://github.com/osbytes/reelsaw/pull/269) [`d664060`](https://github.com/osbytes/reelsaw/commit/d664060c76d308aeb833f3252529050fec115e0a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Transcription through OpenRouter and other OpenAI-compatible servers. The compatible provider (`OPENAI_COMPATIBLE_*`) now serves transcription models as well as language models, so `TRANSCRIPTION_MODEL=openrouter:openai/whisper-large-v3-turbo` works next to `AI_MODEL=openrouter:…`. Whether a transcription model returns the word timestamps that cuts and captions need is no longer decided from its name: the first time Reelsaw meets a model it transcribes a 5-second test clip and checks the answer, remembers the result for 30 days, and refuses a model that fails with that reason. Test under Settings → Models runs the clip again, as do the new `test_model` MCP tool and `reelsaw test-model` command, and the model picker marks which models passed. The picker also lists OpenRouter's speech models and the AI Gateway's transcription models from what those services report.

## 0.35.0

### Minor Changes

- [#263](https://github.com/osbytes/reelsaw/pull/263) [`8437346`](https://github.com/osbytes/reelsaw/commit/8437346020758d4d21a00137b312977d632aac75) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Sign-up rules. Keep sign-ups open and send only the ones that look wrong to approval. A rule matches an address or CIDR range, an email pattern (`spam*@gmail.com`, which dots and `+tags` cannot dodge), an email domain, or an abuse flag worked out at sign-up (a shared address, a burst, a temporary domain). It then holds the sign-up for approval, blocks it, or lets it in at once even when sign-ups need approval. A held account sees the usual "Waiting for approval" page and is never told why; admins see which rule held it on the Users page. Set rules up under Settings → System → Sign-up rules, which also counts what each rule caught and lets you try an address against them; a hold rule's count opens Users filtered to the accounts it held. Or make one from an account: **Add sign-up rule…** in its menu on the Users page offers its address, that address's range, its email and its domain, and can send that account back to approval at the same time. Over MCP they are `list_signup_rules` and `manage_signup_rules`; on the box, `reelsaw signup-rules`. For accounts that already exist, the Users page has **Require approval** for one account or a selection (every flagged account, say), also available as `manage_users` and `reelsaw users-bulk` with `hold`.

### Patch Changes

- [#266](https://github.com/osbytes/reelsaw/pull/266) [`9d909d7`](https://github.com/osbytes/reelsaw/commit/9d909d715f19340ee50d7c35b129620dfa696706) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Security fixes. Hono 4.13.18 and @hono/node-server 2.1.7 close advisories in CSRF checks, form validation, mounted-route middleware, router wildcards and backslash paths, and a crash on a reset WebSocket upgrade. The Docker image now takes Debian's security updates for apt, Cyrus SASL and SRT, and release builds refresh the OS packages every week instead of reusing an old cached layer.

## 0.34.1

### Patch Changes

- [#259](https://github.com/osbytes/reelsaw/pull/259) [`e545be3`](https://github.com/osbytes/reelsaw/commit/e545be34fd375833847407ac1f48a635eed126fd) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Browser traces name uploads correctly. An upload used to show up as `GET /api/upload`, or as a bare `POST` when the connection dropped partway. It is now `POST /api/upload` either way, so failed uploads group together with the ones that finished.

## 0.34.0

### Minor Changes

- [#256](https://github.com/osbytes/reelsaw/pull/256) [`1cbae8b`](https://github.com/osbytes/reelsaw/commit/1cbae8bbb3136e83b6453a15448e8854a8439dd5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - New Project tells you before you submit whether a video fits your plan. Paste a link (or pick a file) and it shows what your minutes cover. A video that would be refused shows why, plus the upgrade offer with its price, before anything is created or uploaded. Agents can ask the same with the new `check_source` MCP tool, and operators with `reelsaw check-source`.
  
  The refusal for a first video longer than the free allowance now says what does fit ("Try a video under 60 minutes") instead of "0 already used passes the monthly limit". Upgrade buttons name the price ("Starter: 100 minutes a month for $12").
  
  On a hosted instance, a project whose finished clips carry the watermark shows which plan removes it and what that costs.

## 0.33.0

### Minor Changes

- [#253](https://github.com/osbytes/reelsaw/pull/253) [`e212468`](https://github.com/osbytes/reelsaw/commit/e212468aaf5770026cbd8cdfaa1408a88af1ece3) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Fades and transitions. A clip can fade in from black and out to black, picture and sound together, and its intro and outro can join it with a cut, a dip to black or a crossfade. Picture and text layers can fade in and out over their window. Set them in the editor's Style tab (renamed from Captions) for one clip or every clip, previewed live while the clip plays, and in Settings → Project defaults for new projects. Over MCP and the CLI they are style fields (`fadeIn`, `fadeOut`, `bumperTransition`, `bumperTransitionSec` on `update_clip { style }`, `update_project_style`, `set_project_defaults` and `reelsaw update-style --set`) and a layer `fade` (`reelsaw clip-layers --add … --fade 0.5`). Off by default; the render reports what it burned in under `diagnostics.transitions`.

## 0.32.5

### Patch Changes

- [#251](https://github.com/osbytes/reelsaw/pull/251) [`8776914`](https://github.com/osbytes/reelsaw/commit/87769146d2b103762c576c4582dd91521904e2b5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Observability fixes from a review of Sentry, PostHog and Langfuse data:
  
  - AI SDK calls are traced again. AI SDK 7 only emits spans through a registered integration, so `OTEL_ENABLED` had produced no model-call spans since the upgrade. `@ai-sdk/otel` is now registered at boot, and spans are named for the call (`invoke_agent analyze.map`) and carry model, tokens, finish reason and the project, stage, step and prompt-version ids. Prompts and answers are never recorded on a span, whatever a call site asks for.
  - Langfuse generations carry their step's prompt version, and a user's decisions about the output (a clip deleted, restored, retimed or added; a fix accepted or rejected) become boolean scores on the project's session, for accounts with learning on.
  - A failed model call's log line names the error class, HTTP status and provider error code, which stay readable when error reporting scrubs the message.
  - A 4xx a handler throws (an MCP client asking for an unsupported protocol version) is a warn with its reason and the requested version, no longer an error report.
  - A missing object on a cache probe (the shared transcription cache) logs at debug instead of warn.
  - With `DB_POOL_MAX` unset, a worker sizes its Postgres pool to its job slots.
  - Browser API spans are named for the endpoint (`GET /api/trpc/projects.get`), calls to other hosts are no longer traced, and DOM errors from browser page translation no longer reach Sentry.
  - Transient download failures are reported as `DownloadFailedError` rather than a bare `Error`.

## 0.32.4

### Patch Changes

- [#246](https://github.com/osbytes/reelsaw/pull/246) [`aea1a38`](https://github.com/osbytes/reelsaw/commit/aea1a38203de17654f5d8266cedfe784ff2a164c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Agents signed in through a connector (claude.ai, Claude Desktop) can download their clips: MCP `export_project` returns a share link for the zip that needs no sign-in, since the keyed `export.zip` link only opens with an API key (`share: false` still asks for it, `share: true` gives API-key callers a share link too). The server instructions now send agents to `get_media_links` or `export_project` for downloads and explain that a 403 comes from the client sandbox's network allowlist, not Reelsaw.

## 0.32.3

### Patch Changes

- [#244](https://github.com/osbytes/reelsaw/pull/244) [`01f756c`](https://github.com/osbytes/reelsaw/commit/01f756cd0d654ad07237d9f998f3f57a422b07e0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The Users page shows whether each account's email address is verified and filters by status and verification (kept in the link). Rows can be selected, or every matching account at once, to approve, suspend, reinstate or delete them together; refusals (yourself, the last admin) are listed with the reason. The waiting-for-approval count covers every account, not only the loaded page, and the list reads from a new index on its sort order. New MCP tools `list_users` and `manage_users`, and `reelsaw users` (now paged, with filters) and `reelsaw users-bulk` on the CLI.

## 0.32.2

### Patch Changes

- [#242](https://github.com/osbytes/reelsaw/pull/242) [`175cc0e`](https://github.com/osbytes/reelsaw/commit/175cc0e3171e0b0263dda71db618df7be6876ee4) Thanks [@dillonstreator](https://github.com/dillonstreator)! - With `MCP_OAUTH` on, Settings → API keys and MCP shows how to connect by signing in (the Claude Code command and the connector address) ahead of API keys, Settings → System says which MCP sign-in the instance accepts, and an unauthenticated `/api/mcp` response mentions signing in.

## 0.32.1

### Patch Changes

- [#241](https://github.com/osbytes/reelsaw/pull/241) [`c52cefe`](https://github.com/osbytes/reelsaw/commit/c52cefe4bd544975c9a826abb59831c021beae6b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Templates, Users and Deleted now share one list layout: the same page width, table, row height, empty state and count. Deleted rows have their own columns and a Restore button that is always visible.

- [#238](https://github.com/osbytes/reelsaw/pull/238) [`e1364fb`](https://github.com/osbytes/reelsaw/commit/e1364fbe7986658d1cc847de6189fd396726f20e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Risky changes now ask first: making or removing an admin, creating an API key that can administer, "Delete forever" on the delete toast, revoking a share link or a project's links, rotating a webhook secret, removing saved provider credentials, replacing a transcript with a file, a style for all clips (it clears per-clip styles), and instance settings that open sign-ups, drop a sign-up guard, reach private networks or shorten retention.

- [#239](https://github.com/osbytes/reelsaw/pull/239) [`09851d0`](https://github.com/osbytes/reelsaw/commit/09851d05273af19c1b17c10639ed76bb8e7327f0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - In Settings → System, Save and Discard stay on screen while you scroll through a long panel.

## 0.32.0

### Minor Changes

- [#170](https://github.com/osbytes/reelsaw/pull/170) [`6ed6437`](https://github.com/osbytes/reelsaw/commit/6ed6437cb7658e14bc4b38c7fb632d9f01ffdf80) Thanks [@dillonstreator](https://github.com/dillonstreator)! - When email is on, a finished project schedules one note. Further projects that finish while it is waiting join the same email, and it is sent only if you have not come back. A first project, and later the 10th, 25th, 50th and 100th, get a line of their own.
  
  Every note carries a one-click unsubscribe (`List-Unsubscribe`, RFC 8058) and a footer link; the note can also be turned off under Settings → Account, with the `get_email_preferences` / `set_email_preferences` MCP tools, or with `reelsaw email-prefs <email> --ready-email off`.

## 0.31.0

### Minor Changes

- [#235](https://github.com/osbytes/reelsaw/pull/235) [`86bb752`](https://github.com/osbytes/reelsaw/commit/86bb752da84643083f971bab59fdb09549890f24) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Settings and the navigation menus are reorganised. Account settings get a side nav like System's, and Plan and billing moves into Account (`/settings/billing` still lands on it); System stays its own tab. The account menu is grouped (you, the instance for admins, theme, help, sign out), and the top bar keeps only nav, search and the menu. Settings → System → Overview replaces the CPU / memory / disk gauges of the process that served the page with fleet tiles (workers, jobs, render slots, failures this week); Workers shows each process's status, why it is paused and a version mismatch; the Queue shows only stages with work (one "Idle" line otherwise), the longest wait, a stage no worker takes, and a retrying job's last error. `get_queue` and `reelsaw queue` gain `oldestWaitingAt` and `lastError` and no longer list pg-boss's internal queues; `list_workers` gains `paused`.

## 0.30.4

### Patch Changes

- [#233](https://github.com/osbytes/reelsaw/pull/233) [`bab3db0`](https://github.com/osbytes/reelsaw/commit/bab3db0bde7ae197fc1677890f6a4383a95a3126) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The "Jobs paused" chip now reflects the workers that run jobs, read from their heartbeats, instead of the machine that served the page: on a split deploy (an API box plus worker boxes) it no longer shows paused because the API box is busy, nor misses a worker that is short of disk. The app checks it every 30 seconds instead of every 10. New metric `reelsaw.quota.minutes_precheck_skipped` counts links downloaded under a minutes limit before their length was known.

## 0.30.3

### Patch Changes

- [#228](https://github.com/osbytes/reelsaw/pull/228) [`5db3047`](https://github.com/osbytes/reelsaw/commit/5db304709573ee811e1fce0c77e7dd2235d08027) Thanks [@sentry](https://github.com/apps/sentry)! - Failures that another attempt cannot change now fail the project right away instead of spending its retries: a private or removed video, a link that is not a supported video, a video over the download size limit, a malformed or internal link, a source with no audio, an upload that is gone, a transcription with no words, and an analysis that found no usable clips. A dead link (404 / 410) is still tried through every configured download proxy first, since a site can answer 404 to one region only. Retryable cases stay retryable: region blocks, age checks, bot checks, rate limits, server errors, an expired media URL, and a failed DNS lookup.

## 0.30.2

### Patch Changes

- [#225](https://github.com/osbytes/reelsaw/pull/225) [`d6d3c44`](https://github.com/osbytes/reelsaw/commit/d6d3c4436c05492d9c2bf8763dc297c6a5249c4e) Thanks [@dependabot](https://github.com/apps/dependabot)! - Dependencies: Bump alpine from 3.20 to 3.24.

## 0.30.1

### Patch Changes

- [#218](https://github.com/osbytes/reelsaw/pull/218) [`64b8187`](https://github.com/osbytes/reelsaw/commit/64b81876755597f912c3513ea342716def5b5f7b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Share links and webhooks are easier to use in the browser and on a phone. When the browser blocks the clipboard, "Copy share link" (and every Copy button for links and secrets) shows the link to copy by hand instead of an error, so a link that was made is never lost. On a phone, a webhook's status and last delivery get their own line, the delivery log keeps its time inside the card, and share links show their state, expiry and uses. "Rotate secret" is disabled while a rotation is still open and says until when; rotation messages give the time as `2026-11-01 21:57 UTC`. "Revoke all share links" stays hidden until there is one to revoke, the clip menu's "Copy link" is now "Copy page link" so it is not mistaken for a share link, and an admin's Users link moves into the account menu on a phone so the top bar fits.

## 0.30.0

### Minor Changes

- [#216](https://github.com/osbytes/reelsaw/pull/216) [`01322ee`](https://github.com/osbytes/reelsaw/commit/01322ee0f15b7a583c157faf122c9ca60acbb001) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Outbound webhooks, share links and project metadata. Webhooks POST `project.created`, `project.done`, `project.failed`, `clip.done` and `clip.failed` to your URLs, signed the Standard Webhooks way, written in the same transaction as the event, retried for about a day and turned off (with an email) when an endpoint keeps failing; Settings → Webhooks has a test button, secret rotation and a delivery log with Resend. Share links are revocable public URLs to a clip, thumbnail, captions or a project's zip that expire after 90 days by default and serve the file directly with Range support; `project.done` carries them, so a pipeline can hand a clip to a scheduler without downloading it. Projects take up to 20 `metadata` keys that come back on every webhook. Each ships with MCP tools (`create_webhook`, `get_media_links`, …) and `reelsaw webhooks` / `reelsaw media-links` commands. New settings: `MAX_WEBHOOKS_PER_USER`, `ALLOW_PRIVATE_WEBHOOK_URLS`, `MEDIA_LINK_TTL_DAYS`, `MEDIA_LINK_ALLOW_NEVER`, `MEDIA_LINK_RETENTION_DAYS`, `MEDIA_LINKS_REDIRECT`, `WEBHOOK_DELIVERY_RETENTION_DAYS`, `WEBHOOK_CONCURRENCY`.

## 0.29.2

### Patch Changes

- [#214](https://github.com/osbytes/reelsaw/pull/214) [`2ab9563`](https://github.com/osbytes/reelsaw/commit/2ab95635f8c6c9f3fed440e3f18cc7d318dbf1c0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The server no longer ships the `glob` and `minimatch` versions named in GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249: pnpm overrides move the copies pulled in by OpenTelemetry, Sentry and archiver to glob 14 and minimatch 11.

## 0.29.1

### Patch Changes

- [#210](https://github.com/osbytes/reelsaw/pull/210) [`dcc6db2`](https://github.com/osbytes/reelsaw/commit/dcc6db29a6ce29ebe47f99fdcc81d6ff73558d73) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Release images build again with the Sentry source map upload on: the build stage now has CA certificates, so `sentry-cli` can reach Sentry. A failed upload (Sentry unreachable, a bad token) now prints a warning and the release goes on without maps instead of failing.

## 0.29.0

### Minor Changes

- [#208](https://github.com/osbytes/reelsaw/pull/208) [`35cf69d`](https://github.com/osbytes/reelsaw/commit/35cf69d9c2c70800c5c8508b1e092c406166a7b1) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Error reporting and product analytics see more and leak less. Every `error` or `fatal` log line that carries an error now goes to Sentry, tagged with the line's ids, so nothing needs a separate capture call: that adds 5xx responses from file routes, uploads and the MCP endpoint, unexpected MCP tool errors, jobs the reconciler gave up on, failed emails and failed billing syncs. A job attempt that will be retried, and connection errors that recover on their own, are now warnings. The worker heartbeat, the reconciler and the daily billing reconcile check in as Sentry cron monitors. The browser no longer reports the 4xx refusals it already shows, keeps no IP address, and can keep a fully masked replay before an error (`SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE`, off by default). Release images upload source maps to Sentry when the release workflow has a token, and still ship none. PostHog events no longer carry a project's title or an error message. New events: `project.cancelled`, clip done and failed, requested jobs, quota refusals, clip downloads and exports, MCP tool calls, approvals and email verification, each tagged with its surface (web, api, mcp, cli). Traces drop the per-click browser spans and parentless client spans, and server spans are named by route.

## 0.28.2

### Patch Changes

- [#204](https://github.com/osbytes/reelsaw/pull/204) [`7bf7789`](https://github.com/osbytes/reelsaw/commit/7bf7789a95f2c2a7b90501d33725345315a0a9f6) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Sign-in and sign-up rate limits now key on each visitor's own address behind a reverse proxy (Railway, Caddy), instead of one bucket shared by everyone. A link longer than the account's remaining minutes is refused when the project is created, with the upgrade offer, instead of becoming a failed project. "Jobs at once" now counts only what the user asked for, so a project's own renders no longer block the next request. Sign-ups that must confirm their email are now counted in product analytics.

## 0.28.1

### Patch Changes

- [#202](https://github.com/osbytes/reelsaw/pull/202) [`c441b3b`](https://github.com/osbytes/reelsaw/commit/c441b3b3d02603570c3825bad075cca0a7746ec7) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Several projects at once on a CPU-only box no longer time out over and over while transcribing: a call waiting its turn for a local model no longer counts against its time limit, a local whisper (Speaches) now takes one transcription at a time unless `PROVIDER_CONCURRENCY` says otherwise, and a self-hosted transcription gets at least twice the chunk's audio length before it times out. An admin's issue report with instance-wide diagnostics no longer fails while projects are in progress, and a report that fails now logs why.

## 0.28.0

### Minor Changes

- [#201](https://github.com/osbytes/reelsaw/pull/201) [`c6ac53c`](https://github.com/osbytes/reelsaw/commit/c6ac53cb56f01914e34f974543fbe5987009560b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Burned-in captions in tight close-ups are blurred again: a caption band that reaches a speaker's chin is trimmed to below the face instead of being dropped, each blur covers only the text on screen at that moment (still scene text beside the band, like a label on a desk, is left alone), and blurs have a soft edge and fade in and out instead of switching on as a hard box. In split and stack sections, captions now sit on the line between the two panes (a switch in the editor's caption settings turns it off).

- [#199](https://github.com/osbytes/reelsaw/pull/199) [`ee84e55`](https://github.com/osbytes/reelsaw/commit/ee84e55083105edae5d5899fa5e7c4128126e907) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Layer templates can carry an intro and outro. Pick them in the template editor's new Intro & outro block (Clip's own, None or a library video or image); applying the template sets them on the clips as their own choice, in the same step as the layers, and new clips of a project that uses the template get them too. Save as template keeps the clip's intro and outro. Also in the `save_layer_template` / `update_layer_template` MCP tools (`bumpers`) and `reelsaw templates set --intro / --outro`.

## 0.27.2

### Patch Changes

- [#196](https://github.com/osbytes/reelsaw/pull/196) [`ba0a96d`](https://github.com/osbytes/reelsaw/commit/ba0a96de2c1a03f05266c32d08cd3fabcaa1eea4) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The installers (`install.sh`, `install.ps1`) now find a database volume left by an earlier install under the same project name, keep its data and set its password from `.env` before the app starts, so a lost `.env` or a second install folder no longer leaves the app looping on `password authentication failed`. That boot error now says why and points at the fix. On a first boot the log now says that the speech-to-text model is being downloaded and that the app answers only afterwards, with a line every 20 seconds while it runs and the elapsed time when it is done.

- [#197](https://github.com/osbytes/reelsaw/pull/197) [`081850f`](https://github.com/osbytes/reelsaw/commit/081850fdac991aa72ecb1fc25ec64fcfb215ef9c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The project page header no longer prints the title twice: the breadcrumb's last crumb is the heading.

## 0.27.1

### Patch Changes

- [#193](https://github.com/osbytes/reelsaw/pull/193) [`074b44b`](https://github.com/osbytes/reelsaw/commit/074b44b70dc3a217ab74cc6b6e56d901e2fa8b6d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The sign-in, sign-up and password cards now show the title on the left with the logo at the top right, and no longer print the host the app runs on.

## 0.27.0

### Minor Changes

- [#191](https://github.com/osbytes/reelsaw/pull/191) [`5016e2a`](https://github.com/osbytes/reelsaw/commit/5016e2a069272dab6ba58c41d7a7a909f0879dbf) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Decision log: what you accept, reject, cut, correct and edit is recorded (with the words or clip text it was about, the models that proposed it and a fingerprint of the source) and outlives deleted projects, so Reelsaw keeps learning after "Delete forever" (rejected cuts from deleted projects still teach the filler detector). Settings → Learning turns it off or forgets everything; the delete and "Delete forever" dialogs can forget one project's decisions (a choice made at delete time holds for the automatic purge too). New MCP tools `list_decisions`, `export_decisions`, `forget_decisions`, `set_learning` (and `forgetDecisions` on `delete_project` and `purge_project`), CLI `reelsaw decisions` (list, export, forget, backfill of decisions made before this release), `DECISION_RETENTION_DAYS` (default keep). Ingest records the source's sha256, video id and format. Evals: `harvest-decisions.ts` turns an export into disfluency candidates split by project, and the `decisions` suite replays today's detector against users' decisions.

### Patch Changes

- [#189](https://github.com/osbytes/reelsaw/pull/189) [`3afa8dd`](https://github.com/osbytes/reelsaw/commit/3afa8ddcb274457ec910b0df0f5f673d3f7b8cf0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Game and app interfaces are no longer blurred as burned-in captions. The on-screen text scan now tells interface text (scores, player lists and menu buttons pinned to the side of a gameplay or screen recording) from subtitles, logos and lower thirds, and leaves the interface visible. New projects get this automatically. For an existing project, an operator can re-scan with `reelsaw overlays <projectId> --store` and then re-render the clips.

## 0.26.4

### Patch Changes

- [#187](https://github.com/osbytes/reelsaw/pull/187) [`0979432`](https://github.com/osbytes/reelsaw/commit/0979432cae87902696f594e8c8028383d53f0108) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Leaner, cleaner container image: the image no longer ships tools the app never runs (drizzle-kit, tsx and their esbuild binaries, npm, corepack, yarn, gosu), which cleared every fixable vulnerability the image scanner reported. The entrypoint, `reelsaw` CLI and health check drop to the `node` user with `setpriv` instead of `gosu`.

## 0.26.3

### Patch Changes

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`1d0bceb`](https://github.com/osbytes/reelsaw/commit/1d0bceb7e409c6d5d732baf00d193aa2c080854f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Filler and repeat removal with the language model (`DISFLUENCY_LLM`) and the AI packaging of clips you cut by hand now save their work as they go, so a timeout or restart continues where it stopped. A timeout used to finish the filler pass with only part of the transcript checked and no warning; it now fails the step so Retry completes it. A long selection for "find the best moment" is searched in parts instead of one prompt.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`f3a94cc`](https://github.com/osbytes/reelsaw/commit/f3a94cc8bcf0120ac930e21f9c15e23c42408837) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Shot cuts are saved the moment they are found and the on-screen text scan is its own resumable step, so a text-scan timeout no longer loses them. A failed shot-change decode now retries and, if it keeps failing, shows as a failed scenes step with its reason instead of being stored as "no cuts".

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`bf26baf`](https://github.com/osbytes/reelsaw/commit/bf26baf0cd2a7b8d59165e0b2f5481d7fc54b088) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Transcription now saves each audio chunk as a step, so its progress, time left and timeouts behave like finding moments and a retry continues after the last finished chunk. With S3 storage the speech-to-text cache is shared across hosts. A "no progress" warning now says which stage is stuck, how many parts are done and when the last one finished, and it also fires when a model keeps ticking but finishes no part.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`389a4de`](https://github.com/osbytes/reelsaw/commit/389a4de071063bc4c2cfe3c2b6b9fe6566052343) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Fixes several races that could leave a project stuck or out of date: re-analyze no longer overwrites a settings change made at the same time, Retry after a failed re-analyze picks clips again, deleting the last clip of a rendering project finishes it, and a rename during the download survives. Refining a busy project is refused instead of overwriting its status.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`e3d14fe`](https://github.com/osbytes/reelsaw/commit/e3d14fe06b62e10a0abc609539441a1626f5d537) Thanks [@dillonstreator](https://github.com/dillonstreator)! - New MCP tools for agents: review and correct transcript fixes (`list_transcript_flags`, `review_transcript_flags`, `add_transcript_correction`, `add_transcript_cut`), read and set project defaults, open the billing portal, and start a project from an uploaded file with `create_project`'s new `uploadId`.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`3f6c629`](https://github.com/osbytes/reelsaw/commit/3f6c629cdfb5f29fc3f45cb3a1c333f266864f36) Thanks [@dillonstreator](https://github.com/dillonstreator)! - "Not found" answers now say what is missing in plain words, and the MCP clip tools report what changed and whether a render was queued (`update_clip`, `create_clip`, `delete_clip(s)`, `rerender_clip(s)`; `get_clip` also shows the style and framing it will render with and where they come from). Editing a clip's length now has the same 3 second to 10 minute limits as creating one. The command line can create projects, retry, re-analyze, refine, delete, export and create or edit clips, `rerender` prepares clips that never got a title, and `recover` retries a failed project. The templates and library lists load a page at a time.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`86e9b35`](https://github.com/osbytes/reelsaw/commit/86e9b356c948e85cbb27b180d040a9a0bf32f083) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Each Reelsaw process now writes its own log file (`reelsaw.<worker id>.<date>.log`), so scaled workers no longer delete each other's logs; `reelsaw logs` and issue reports read and merge them all. Stopping the app now ends open event streams and waits briefly for open requests before draining jobs, and `STOP_GRACE_PERIOD` in `.env` sets how long Docker waits (raise it with `SHUTDOWN_GRACE_SECONDS`). Analysis and refine steps get more time on long videos (up to 3 hours, twice the video length), and the database pool is configurable with `DB_POOL_MAX`, with connect and idle-transaction timeouts, so model calls cannot starve job heartbeats. **Upgrade:** the release notes now list the irreversible migrations; take a `pg_dump` before upgrading.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`59de27d`](https://github.com/osbytes/reelsaw/commit/59de27da38e97b6bb38d9d5188f4f627e548f328) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A job that keeps crashing its worker now fails with "Processing was interrupted 4 times" and a Retry button instead of being re-queued forever, and a worker short of disk no longer hangs while handing its job to another worker. `/api/health` now checks the database, live-update connection, job queue and worker heartbeat and answers 503 when one is down, and the live-update connection keeps retrying after a failed reconnect.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`2d994c7`](https://github.com/osbytes/reelsaw/commit/2d994c794b924f617468bda7a1a0582b27e7093d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A plan's free first video now goes to your first video whose length is known, not to one that was still downloading or failed early. Uploads that became a project are no longer counted twice against storage, and the storage limit is enforced on every upload path, including library imports and parallel uploads. Links longer than your allowance are refused before they are downloaded, and are not retried. Re-analyze and refine runs now count toward the hourly re-render limit. An unknown Stripe price is reported to admins, and an account with an existing Stripe subscription is sent to the Billing Portal instead of a second Checkout.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`7bef402`](https://github.com/osbytes/reelsaw/commit/7bef4027b017c74d41b9519ac51fec65bd595f4f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Follow-up fixes from review: a lost job no longer burns a retry when it was still running, uploads without a size reserve disk for the largest allowed file, a deleted project's late job is no longer reported as a failure, and the analysis step no longer times out on work that follows a finished step. Changing source text or caption style now tells you which clips were still rendering and need a re-render, cancelling uploads keeps projects that were already being created, and API keys without a permission record are no longer administrators (older keys were granted it explicitly, visible in Settings).

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`2bc2caa`](https://github.com/osbytes/reelsaw/commit/2bc2caae26f598c9939b44dddc0effcf0325356d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - API keys now have permissions: admins choose whether a key may change instance settings over MCP, and OAuth connectors never can. Connected apps can be reviewed and revoked in Settings, the consent screen shows where approval returns to, and client registration is rate-limited. New TRUSTED_PROXY_HEADER and TRUSTED_PROXY_HOPS settings stop spoofed client addresses, server-side link fetches can no longer be redirected inside your network, CSV exports neutralise spreadsheet formulas, uploaded SVGs from S3 keep their sandbox, and sign-up no longer reveals whether an email has an account.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`92351f2`](https://github.com/osbytes/reelsaw/commit/92351f2fa2aa27b57e6e8c1af7bf5ad4a5678a93) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Long videos on slow local models no longer fail after 30 minutes: finding moments now saves each part of the transcript as it finishes, so Retry (and any automatic retry) continues where it stopped instead of starting over, and the project page shows "13 of 43 parts, about 1 h left". A timeout now says how far it got and what to do, and two new settings, `LLM_CALL_TIMEOUT_SECONDS` and `STAGE_IDLE_TIMEOUT_MINUTES`, set how long a model call and a stage without progress may take.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`bd0e4b8`](https://github.com/osbytes/reelsaw/commit/bd0e4b8de7f6cea2c3b6b45e4f7b710c3b0b7fe9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A crash during audio extraction can no longer leave a truncated file that a retry transcribes silently. Clip retention now frees the disk it promised (clips and thumbnails, local and S3 scratch), a project whose source was removed by retention is fetched again by Retry (clips then re-render on demand, with a clear message until then), abandoned uploads are cleaned up after a day, and S3 storage checks write access at boot and handles concurrent source pulls safely.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`b44e634`](https://github.com/osbytes/reelsaw/commit/b44e634cf50f6315712b1025c37f35dd46aceca3) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Agents and the CLI can now hide or keep text burned into the source (`set_project_source_text`, `reelsaw source-text`) and change a project's caption style (`update_project_style`, `reelsaw update-style`), as the screens already could. Docs say that a retry on a long video resumes from the last finished part.

- [#185](https://github.com/osbytes/reelsaw/pull/185) [`2093120`](https://github.com/osbytes/reelsaw/commit/2093120437ee03394579190b0ce8e66e6370e386) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Live updates on the project page and the clip editor now recover after a sign-in expiry or a network blip (with a small "reconnecting" note), and a long activity log stays complete after a reconnect. Uploads check the file size against the server's limit up front, can be cancelled one by one or all at once, and warn before you close the tab mid-upload.

## 0.26.2

### Patch Changes

- [#178](https://github.com/osbytes/reelsaw/pull/178) [`aeb91e9`](https://github.com/osbytes/reelsaw/commit/aeb91e9c3a9e66c301ec07d73eaebd80fe2853ac) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The app now asks search engines not to index it (`<meta name="robots" content="noindex">`) and serves a `robots.txt` instead of a 404. Its pages are sign-in screens and private workspaces, so search results should point to the website, and this applies to self-hosted installs too. App links pasted into chat now get a title and description preview.

- [#184](https://github.com/osbytes/reelsaw/pull/184) [`e739559`](https://github.com/osbytes/reelsaw/commit/e7395595cd94767222ce10eb97a3ecd1c79cbf2e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A job leases the disk it is about to write before it writes it. `statfs` sees only bytes already on disk, so two
  ingests of large videos that both passed the free-space check on the same volume could both run out mid-download
  and both fail. The governor now checks a job's need against the volume's live leases and records its own claim in
  the same locked transaction (`disk_leases`, one advisory lock per volume): the second job waits for the first
  ("Waiting for resources: … leased to 1 job in flight"), evicting idle cache copies once first, and gives up after
  `RESOURCE_WAIT_MAX_SECONDS` for pg-boss to retry. Stages release the lease when they end (ingest as soon as the
  source is on disk), and a stage that has to pull the source from the S3 store leases that pull too; a lease counts
  while its worker has heartbeated within 10 minutes and expires after the longest a stage job may run, a process
  drops its own at boot and once its jobs have stopped at shutdown, so a crash leaks nothing for long. Processes
  sharing a volume (the `DATA_DIR/.volume-id` marker) share one ledger;
  a worker on another host never contends. The heartbeat reports the volume's leased total (`diskLeasedMB`: Workers
  page, `reelsaw workers`, `list_workers`), a hand-off counts it as used, and `reelsaw storage` shows "leased to jobs
  in flight on this volume". Migration `0045_disk_leases`.

## 0.26.1

### Patch Changes

- [#181](https://github.com/osbytes/reelsaw/pull/181) [`cdab2d4`](https://github.com/osbytes/reelsaw/commit/cdab2d40dd6e5577acaf0d45d82702ea506b5a37) Thanks [@dillonstreator](https://github.com/dillonstreator)! - With an S3 store, a worker's local copies of sources and rendered clips are now treated as the cache they are. The hourly sweep evicts the copies of finished projects idle longer than `SCRATCH_CACHE_HOURS` (24; a runtime setting under Settings → System → Retention), `reelsaw storage` reports them, and `reelsaw storage reclaim <MB>` frees a given amount least-recently-used first. A job short of disk no longer fails at once: it evicts first, then, if another live worker has the room, hands the job to it and stops taking media jobs on this worker until free disk is back above `MIN_FREE_DISK_MB` plus 1 GB (Settings → System → Workers shows "disk full"); only when no worker has the room does the run fail. The speech-to-text cache is pruned hourly as well as at boot.

## 0.26.0

### Minor Changes

- [#176](https://github.com/osbytes/reelsaw/pull/176) [`7d697db`](https://github.com/osbytes/reelsaw/commit/7d697dbd106e5156ac8f7e2becc9b255fa021fa6) Thanks [@dillonstreator](https://github.com/dillonstreator)! - With `OTEL_ENABLED=true` (or Sentry Application Metrics), the server now exports metrics for the pipeline, yt-dlp proxies and model calls, and not only span durations. Each stage, link download and transcription is measured in seconds of work per second of video, so a 30-second clip and a 2-hour talk can be compared. Proxy pools report attempts by proxy and outcome, circuit changes, health, in-flight downloads and download speed. Language model calls report latency, tokens and cost by model and pipeline step. Render slots and active jobs are reported as gauges. Span-duration metrics no longer carry project, clip or attempt attributes, which had made one series per project. The README lists every metric.

## 0.25.0

### Minor Changes

- [#174](https://github.com/osbytes/reelsaw/pull/174) [`70d326d`](https://github.com/osbytes/reelsaw/commit/70d326d76b0013f74f98af38e21579cded12e50c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Tabs left open across an upgrade keep working: the command palette and other lazily loaded parts no longer fail with a missing-file error, and a tab on an older version reloads itself on its next page change when nothing is unsaved. Library tags use a picker that suggests tags you already use and creates new ones. Deleting library items and templates is now called Delete everywhere, matching projects and clips, and the MCP tools are `delete_asset` and `delete_layer_template` (the CLI's `library delete` and `templates delete`); `refine_project` is a new MCP tool. Large uploads are no longer cut off after five minutes, migrations are safe when several workers start at once, container logs rotate, and leftover temporary files are cleaned up. Adding a library item from a URL now refuses every internal address form, pages can no longer be framed by other sites, and password-reset tokens stay out of the access log. Re-picking or retrying a project while it is still working no longer leaves two sets of clips or brings back a deleted project, and edits made to a new clip while it is being prepared are kept. Project actions that fail now say why, and leaving the clip or template editor with unsaved edits asks first, from any link, ⌘K or the browser's Back button.

## 0.24.0

### Minor Changes

- [#171](https://github.com/osbytes/reelsaw/pull/171) [`ee190fb`](https://github.com/osbytes/reelsaw/commit/ee190fbfb99cb946620dbce9d7fb9c2df2a2d998) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A Deleted page lists deleted projects, clips, library assets and layer templates in one place, with bulk restore and delete forever. Deleting clips from a project offers Undo, Delete forever and a link to the page, and the same restore, delete forever and list actions are MCP tools and CLI commands. Deleted items keep counting toward storage until they are deleted forever, and minutes used stay counted after a delete forever.

## 0.23.3

### Patch Changes

- [#167](https://github.com/osbytes/reelsaw/pull/167) [`608c446`](https://github.com/osbytes/reelsaw/commit/608c4467498e351c3066f71bf5c89237495631c5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Renders of many clips at once no longer fail inside ffmpeg on large machines (filter-graph thread races and face-frame sampling).

## 0.23.2

### Patch Changes

- [#165](https://github.com/osbytes/reelsaw/pull/165) [`7565d38`](https://github.com/osbytes/reelsaw/commit/7565d38817f95b37cdc8c7de3b2a1d9c7639bde6) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `YTDLP_PROXY` URLs may include `{session}`, replaced with a fresh id on every yt-dlp download so a residential gateway can pin that process to one IP and give the next video a different one. Ingest also passes `--js-runtimes node` (YouTube JS challenges) the same way eval already did.

## 0.23.1

### Patch Changes

- [#163](https://github.com/osbytes/reelsaw/pull/163) [`8943cca`](https://github.com/osbytes/reelsaw/commit/8943cca9d7e19d2b349e10cc850655deaa8fd2e5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The Docker image and production bundle now run Node 24 LTS (the same line CI already uses). The base image stays digest-pinned on the 24 line so Dependabot can pick up 24.x security releases.

## 0.23.0

### Minor Changes

- [#161](https://github.com/osbytes/reelsaw/pull/161) [`7fe603f`](https://github.com/osbytes/reelsaw/commit/7fe603f4666a70dcdbc1f64f869b3ca63aa86049) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Whisper decoder loops (one word or a prompt list cycling for minutes) are collapsed after transcription, and each collapse shows up as a transcript fix. The as-heard repeats stay in the transcript; rejecting the fix puts them back. Captions stay empty across that stretch unless you type replacement text on the flag. Re-transcribe to recover the missing speech.

- [#159](https://github.com/osbytes/reelsaw/pull/159) [`bdd11ae`](https://github.com/osbytes/reelsaw/commit/bdd11aee514abaf3d5b0ba3f9860a20fecfd4646) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Framing follows the source's cutting. Shot cuts are now detected for every project before clip selection (they used to exist only when a project opted into the scenes refine step, which is now just the on-screen text scan), clip boundaries snap to them, a render detects them on the clip when an older project or an imported report has none, and the layout may change at every cut: a multi-camera talk show that alternates a close-up with a wide shot every second or two gets a full-frame close-up, then the wide shot, then the close-up again, instead of one split held across a dozen shots with a pane framed on an empty seat. A wide shot of three or more people is shown whole rather than split between two of them. Name fixes and the on-screen text scan now run by default (instance gates `TRANSCRIPT_CORRECTION` and `REFINE_SCENES`, project settings `refineEntities` and `refineScenes`); filler removal stays opt-in. Importing an issue report whose project was re-rendered no longer fails on its timestamps.

## 0.22.0

### Minor Changes

- [#157](https://github.com/osbytes/reelsaw/pull/157) [`88481f0`](https://github.com/osbytes/reelsaw/commit/88481f053a1c602b7902e224bba9644c66527bd9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Crops can be set by hand on top of what framing decides. Right-click the picture in the editor (or a section on the timeline, or the Crop… button on a section) for Set crop…, which fixes the pane under the pointer to an exact part of the source: a box to drag, resize or draw over the whole source frame, with the numbers beside it, starting from what shows now; a split's two panes, a stack's screen and speaker, and a fitted frame each take their own. A crop shaped like the pane fills it, any other shape is fitted over a blurred copy like a webcam tile, and dragging the picture moves a fixed crop. Over MCP, `update_clip` sections take `crop`, `crop2` and `contentCrop`. The hook on the preview has the same right-click menu as a text layer: edit it in place (or double-click it), centre it, reset its position, or hide it.

- [#157](https://github.com/osbytes/reelsaw/pull/157) [`c1501c1`](https://github.com/osbytes/reelsaw/commit/c1501c164a0d4b39fd20d2d08d65d4254e0d04c8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - One clip's framing for the whole project. For a recording whose layout never changes (a slide deck with a webcam tile, a fixed camera), set the framing on one clip and pick "Use for all N clips…" on its Framing tab: the section's mode and its nudge, subject or crop become the project's framing (`reframe` and the new `reframeAdjust` setting), every clip's own sections are cleared, the finished clips re-render, and clips added later get it too. A clip without framing of its own now shows and renders the project's framing; editing it makes the clip's own, and "Use the project framing" takes it back. Over MCP `apply_framing` does the same from a clip id, `reframeAdjust` is a project setting like the others, and the CLI has `apply-framing`.

- [#157](https://github.com/osbytes/reelsaw/pull/157) [`6735b9a`](https://github.com/osbytes/reelsaw/commit/6735b9a99b096bce13a402e5530a1caae9614cbc) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Screen + speaker framing finds the webcam tile (the picture-in-picture box of a Zoom, Teams, Meet or OBS recording) around the speaker's face and shows just that tile in the speaker pane, instead of a face-sized crop that reached into the slides, the black column or the name plate. A tile in a flat band along a frame edge drops that band from the top pane, so the speaker is not shown twice, and a webcam too small for the face detector most of the time is still framed as a stack when its tile stands steady. A forced Screen + speaker section gets the same tile, and a drag on the speaker pane still nudges it. The framing eval gained `tile` cases for a webinar recording and a corner-webcam screencast.

### Patch Changes

- [#157](https://github.com/osbytes/reelsaw/pull/157) [`d75a456`](https://github.com/osbytes/reelsaw/commit/d75a456f3b66441e6453959fe4432f64043176fd) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A re-rendered clip plays at once. The clip's video and thumbnail are served at a URL that never changes, with an hour-long cache, so after a re-render the project page and the clip preview could replay the previous render for up to an hour (a moved caption or a new crop looked as if it had not been applied). The clip media now carries an ETag and asks the browser to check before replaying, so an unchanged file still costs one small request and a re-rendered one is fetched anew.

## 0.21.0

### Minor Changes

- [#155](https://github.com/osbytes/reelsaw/pull/155) [`1a5a370`](https://github.com/osbytes/reelsaw/commit/1a5a3701841b1e6691d19a83fce726866f8134f8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Changelog at reelsaw.com/releases (GitHub feed, 90-day commit heatmap). The app's What's new, version line and update banner link there; `list_releases` and `reelsaw releases` read the same feed.

## 0.20.0

### Minor Changes

- [#153](https://github.com/osbytes/reelsaw/pull/153) [`90ef339`](https://github.com/osbytes/reelsaw/commit/90ef3393e0417df2fd0c66ea3f34543895887fdf) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Layers on the editor's 9:16 preview have a right-click menu (edit text, centre, show for the whole clip, bring to front / send to back, copy, duplicate, remove) and a text layer can be retyped in place with a double-click. The Layers lane's right-click menu gained Template…, and applying a template keeps a clip's existing layers unless Replace is chosen.

- [#153](https://github.com/osbytes/reelsaw/pull/153) [`d64e671`](https://github.com/osbytes/reelsaw/commit/d64e6712b49fbc9061b1a7b2d57ccaecea0a4a9e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Layer templates: save a look once (a logo pop in the first seconds, a follow card at the end, a watermark or a music bed) and put it on any clip whatever its length. Template layers are timed from the start, from the end, over the whole clip or as a share of the clip, so they stretch and contract with each clip. Build one from a clip's layers or in the template editor, apply it to selected clips (replacing or adding to their layers, with an optional re-render) or set it on a project so every new clip gets it. Also available as the `list_layer_templates`, `save_layer_template`, `update_layer_template`, `remove_layer_template`, `restore_layer_template` and `apply_layer_template` MCP tools and the `reelsaw templates` command.

## 0.19.1

### Patch Changes

- [#151](https://github.com/osbytes/reelsaw/pull/151) [`d579380`](https://github.com/osbytes/reelsaw/commit/d579380a691c35e615a04b0293ce8824646df6b3) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Giphy GIFs play in the library and land on a clip as a small looping sticker you can drag and resize. Adding a catalog or provider item no longer shows it as removed from the library.

## 0.19.0

### Minor Changes

- [#147](https://github.com/osbytes/reelsaw/pull/147) [`d08a8e5`](https://github.com/osbytes/reelsaw/commit/d08a8e5f7a7e3cdd2b7afb6b49eba773d7bd5644) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Operators can set a forgotten password from the shell without email: `reelsaw set-password you@example.com`. `--must-change` signs them in with that temporary password and then a blocking page asks for a new one (no current-password field). Other devices are signed out; API keys keep working.
  
  **Upgrade:** existing databases add `user.must_change_password` at boot (default off). On a box without email, `docker compose exec app reelsaw set-password you@example.com` replaces a forgotten password; pass `--must-change` when the operator invented it.

- [#147](https://github.com/osbytes/reelsaw/pull/147) [`d08a8e5`](https://github.com/osbytes/reelsaw/commit/d08a8e5f7a7e3cdd2b7afb6b49eba773d7bd5644) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Sign-in has Forgot password. When email is on, it sends a 24-hour reset link, and choosing a new password signs out other devices.

### Patch Changes

- [#150](https://github.com/osbytes/reelsaw/pull/150) [`31a78a1`](https://github.com/osbytes/reelsaw/commit/31a78a123958769f5a7247cefc66ee7c26799282) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Catalog and provider items are no longer saved into your library. Search them from the library or editor and add them to a clip; they stay on the instance while a clip uses them.
  
  **Upgrade:** Shared items you had bookmarked under Yours drop out of that list. Clips that already use them are unchanged, and the files still appear in catalog and provider search.

- [#149](https://github.com/osbytes/reelsaw/pull/149) [`99e57c4`](https://github.com/osbytes/reelsaw/commit/99e57c416053f1bc0c3d729b7da5408d1354cf87) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Searching the library no longer calls Iconify (or other remote providers) with an empty query, which used to return an error as you started typing.

- [#149](https://github.com/osbytes/reelsaw/pull/149) [`99e57c4`](https://github.com/osbytes/reelsaw/commit/99e57c416053f1bc0c3d729b7da5408d1354cf87) Thanks [@dillonstreator](https://github.com/dillonstreator)! - After a deploy, a tab that still has the old page reloads itself when nothing is unsaved. If you are in the middle of editing a clip, a header chip asks you to save first, then refresh.

## 0.18.2

### Patch Changes

- [#135](https://github.com/osbytes/reelsaw/pull/135) [`ba237ac`](https://github.com/osbytes/reelsaw/commit/ba237acf2b07599e09d93eee6577d1643280d59e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Dependency updates across the app: AI SDK providers and `ai` 7.0.150, AWS S3 SDK 3.1156, better-auth 1.7.12, posthog, react 19.3.1, react-router 8.5, react-query, lucide icons, vite 8.3.5. OpenTelemetry stays on the 2.12 / 0.223 line and API 1.9 until the SDK moves to 3.0 as a set.

- [#117](https://github.com/osbytes/reelsaw/pull/117) [`1f2cdbe`](https://github.com/osbytes/reelsaw/commit/1f2cdbee0664e4a380690192c9437262e2d23b17) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Dependency fix: body-parser 2.4.0 (GHSA-27r3-jxmh-p828, a denial of service through trailing bytes after a compressed request, reachable through the MCP endpoint's Express layer). The image's base layers are now pinned by digest and Dependabot keeps them, the npm packages and the workflow actions current.

- [#111](https://github.com/osbytes/reelsaw/pull/111) [`ff53ef5`](https://github.com/osbytes/reelsaw/commit/ff53ef55c152786f62212bc10201d393d1e164c8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Reelsaw is published to the official MCP registry as `io.github.osbytes/reelsaw` on every release, and the Docker image carries the registry's server-name label, so registry-aware clients can install the `reelsaw mcp` bridge straight from the image.

- [#124](https://github.com/osbytes/reelsaw/pull/124) [`2a50493`](https://github.com/osbytes/reelsaw/commit/2a50493325aef3ed6db385a61a1055b0b9e98e04) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The image is back on Node 22 LTS (an automated bump had moved it to Node 25, which is not an LTS line and was never built by CI). Automated base-image updates now stay within the major.

- [#131](https://github.com/osbytes/reelsaw/pull/131) [`4cc0fb7`](https://github.com/osbytes/reelsaw/commit/4cc0fb7d22c046f114353e476345493918ec824b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Dependency fixes: nodemailer 10.2.1 (three address-parser advisories, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h) and fast-uri 3.1.9 (four URI parsing advisories reached through the MCP SDK's ajv). Each release's install folder now ships with a provenance attestation next to the zip.

## 0.18.1

### Patch Changes

- [#105](https://github.com/osbytes/reelsaw/pull/105) [`b8f29a7`](https://github.com/osbytes/reelsaw/commit/b8f29a7bde05d78c7b8db91811ecc0f200a64799) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The arm64 image starts again: SVG rasterising uses resvg compiled to WebAssembly instead of a native package that only existed for the build host's architecture.

## 0.18.0

### Minor Changes

- [#102](https://github.com/osbytes/reelsaw/pull/102) [`0f27072`](https://github.com/osbytes/reelsaw/commit/0f270722b001dbbc2666cc51671edd3ce9ad5824) Thanks [@dillonstreator](https://github.com/dillonstreator)! - One library for everything a clip can carry: intros and outros, logos, stickers, b-roll, music and sound effects, now including GIF, WebP and SVG. Clips hold one Layers list (image / video, text, sound) on a single editor lane that replaces the Overlays and Music lanes (`update_clip { layers }`, `reelsaw clip-layers`). The Library page and the editor pickers share one finder that searches your items, the bundled Reelsaw catalog (CC0 / permissive sounds, icons and emoji) and, with an admin-provided key, Pexels, Pixabay, Freesound, Iconify, Giphy and Klipy; adding a result imports it once per instance as a shared asset with its license and credit recorded, and "Add to clip" in the editor does both in one step. Usage counts come from an `asset_refs` table instead of scanning clips. New MCP tools: `list_assets`, `add_asset`, `update_asset`, `remove_asset`, `restore_asset`, `asset_usage`, `search_library`, `import_asset` `search_assets` finds items in your library, the catalog and providers (`library.search`), and `add_asset` adds from an upload, a link or a search hit (`library.add`). One `library` router replaces `bumpers` and the user-facing `catalog` router. Migration 0039.
  
  Removed: the MCP tools `list_assets` (use `search_assets` with `source: "library"` and an empty `q`), `search_library` (`search_assets`), `import_asset` (`add_asset` with `provider` + `externalId`) and the `*_bumper` aliases (`list_bumpers`, `add_bumper`, `rename_bumper`, `remove_bumper`, `restore_bumper`, `bumper_usage`; use the `*_asset` tools); the CLI commands `reelsaw bumpers`, `clip-overlays` and `clip-audio` (use `reelsaw library …` and `clip-layers`; `library import` is now `library add <provider:externalId>` and `--provider` is `--source`); and the `overlays` / `audio` inputs of `update_clip` and fields of `get_clip` (use `layers`).

### Patch Changes

- [#103](https://github.com/osbytes/reelsaw/pull/103) [`a9cb821`](https://github.com/osbytes/reelsaw/commit/a9cb8211674b64c658bc31d2d1b8f964c9a9ad5b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Confirmation links work for 24 hours and only once. An expired or superseded link opens a page that sends a new one, and sign-in offers the same when the mailbox is not confirmed yet.

## 0.17.2

### Patch Changes

- [#100](https://github.com/osbytes/reelsaw/pull/100) [`4f94838`](https://github.com/osbytes/reelsaw/commit/4f9483893ed58474de7a1a885035ba6b564e7923) Thanks [@dillonstreator](https://github.com/dillonstreator)! - On a phone, the selected-clips action bar stays on screen while the browser URL bar is showing. Full-height shells now follow the visible viewport (`100dvh`) instead of `100vh`, which is taller than the screen with chrome visible.

## 0.17.1

### Patch Changes

- [#97](https://github.com/osbytes/reelsaw/pull/97) [`11c78d7`](https://github.com/osbytes/reelsaw/commit/11c78d7f3252196660bcedcd5a2c5ca3a658a12a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Project failures show a short plain-language message instead of a wall of yt-dlp stderr. Admins see operator hints (env keys) and optional technical details; everyone else gets a generic line with no platform details. Download errors from a broken proxy are explained clearly.

- [#99](https://github.com/osbytes/reelsaw/pull/99) [`bd478e4`](https://github.com/osbytes/reelsaw/commit/bd478e43bd06324f48bbe72b99d7fdde0a22419b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - App and transactional emails link to the source on GitHub (`github.com/osbytes/reelsaw`): login and pending pages, the account menu, Settings next to the version, and the email footer (HTML and plain text).

## 0.17.0

### Minor Changes

- [#95](https://github.com/osbytes/reelsaw/pull/95) [`2c67f49`](https://github.com/osbytes/reelsaw/commit/2c67f499f416765455ca17701c42375d6fd3838b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Library: "used by" now counts every role an item plays (intro, outro, overlay, music track) and the usage list says which, per project and clip; items can be renamed from the card or the viewer; music plays in place on the card and in the viewer. `list_bumpers` adds `usedByClips` and `url` (the file), `bumper_usage` returns the roles per clip with overlay and music counts.

## 0.16.0

### Minor Changes

- Background music from the library plays under a clip: several tracks per clip on their own lane, each with window, offset, level, fade and loop, loudness-normalised and ducked while someone speaks. Captions and transcripts export as SRT/VTT (routes, zip, MCP, CLI), and an SRT/VTT file can be imported as a project's transcript. Text overlays take a font from the image (DejaVu, Liberation, Roboto, Open Sans, Lato, Inter, Bebas Neue), and ⌘C/⌘V copy and paste overlays and tracks in the editor. New: `clips.audio`, `clips.captions`, `update_clip { audio }`, `get_clip_captions`, `get_project_transcript_file`, `import_transcript`, `reelsaw clip-audio`, `captions`, `transcript-file`, `import-transcript`, `GET /api/fonts/:family`.

### Patch Changes

- [#92](https://github.com/osbytes/reelsaw/pull/92) [`0f3a7dd`](https://github.com/osbytes/reelsaw/commit/0f3a7dddd51a372b50772fe496f26b9b4b90faa5) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Keyboard shortcuts go through one binding helper (react-hotkeys-hook) instead of hand-rolled listeners, so the typing rule and the platform modifier are the same on every screen. ⌘K no longer splits framing in the clip editor; it only opens the command palette (⌘B splits, as the `?` sheet says).

## 0.15.0

### Minor Changes

- [#89](https://github.com/osbytes/reelsaw/pull/89) [`43ecc28`](https://github.com/osbytes/reelsaw/commit/43ecc28607fb0ba1a1c3304cfabf65dc5883c51d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clip editor: per-pane focus in split framing with follow awareness (drag either speaker; drop a pane on someone else to follow them), an Overlays lane for library images, videos and lines of text, intro/outro as blocks on the clip track, and one action bar with the preview's controls in a canvas header. The watermark is now the logo with the site name under it, top-left outside the platforms' dead zones. New: `clips.overlays`, `update_clip { overlays }`, `reelsaw clip-overlays`, `WATERMARK_LOGO_PATH`.

## 0.14.0

### Minor Changes

- [#83](https://github.com/osbytes/reelsaw/pull/83) [`65c0b7e`](https://github.com/osbytes/reelsaw/commit/65c0b7eb8a562f5ac1a842f4274324b3942e3a87) Thanks [@dillonstreator](https://github.com/dillonstreator)! - When OpenTelemetry points at Sentry, traces and logs go to Sentry's OTLP endpoint, and metrics go through the Sentry SDK. Sentry does not accept OTLP metrics. Logs are the same pino lines as the local log, with prompts, transcripts and secret values left out. The browser records traces on the same rate (`OTEL_TRACES_SAMPLE_RATE`, default all of them) and its API calls, including live subscriptions, stay on the server's trace.
  
  **Upgrade:** With `OTEL_ENABLED=true`, a Sentry OTLP endpoint and `SENTRY_DSN` set, the server starts sending logs and, unless `OTEL_METRICS_ENABLED=false`, runtime gauges and span durations. The browser starts sending traces too. Set `OTEL_METRICS_ENABLED=false` to keep traces and logs only, or `OTEL_TRACES_SAMPLE_RATE` below 1 to keep fewer traces.

### Patch Changes

- [#85](https://github.com/osbytes/reelsaw/pull/85) [`dd23f2b`](https://github.com/osbytes/reelsaw/commit/dd23f2b7f9c8c96a8a904e3ff11bfcd77771e77e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Signing in to an account that is waiting for approval shows that waiting message instead of "Email not verified". The sign-in form asks for the current password, so a password manager does not generate a new one that was never stored. A repeat sign-up for an existing email is refused instead of looking successful.

## 0.13.0

### Minor Changes

- [#80](https://github.com/osbytes/reelsaw/pull/80) [`8ba227c`](https://github.com/osbytes/reelsaw/commit/8ba227caa5c4008ef5a3a5e103b9c68b293f3801) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Show each API and worker process under Settings → System → Workers, and a Queue section for live job depth, failed work, and bulk retry after a platform fix. A failed-work row opens the recorded reason (Retry, Copy, Open project); `#queue&fail=kind:id` deep-links it. Admins get the same from `list_workers` / `get_queue` / `list_failures` / `get_failure` / `retry_failures` and `reelsaw workers` / `reelsaw queue` / `reelsaw failure` / `reelsaw retry-failures`.

### Patch Changes

- [#80](https://github.com/osbytes/reelsaw/pull/80) [`8ba227c`](https://github.com/osbytes/reelsaw/commit/8ba227caa5c4008ef5a3a5e103b9c68b293f3801) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can tick **Instance-wide diagnostics** on Report an issue to include unfinished work, failed jobs, usage and error logs across every account — not only their own projects. `reelsaw report --instance` and the `report_issue` MCP tool do the same.

## 0.12.0

### Minor Changes

- [#77](https://github.com/osbytes/reelsaw/pull/77) [`16f9d5b`](https://github.com/osbytes/reelsaw/commit/16f9d5b3e22f323157d2d2960f62b1fd0b5e0335) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `YTDLP_PROXY` accepts one URL or an operator-ranked pool. Priority is what you set; a circuit breaker skips a candidate after consecutive faults and never lets a more reliable expensive proxy overtake a healthy cheaper one. `reelsaw ytdlp-proxies` shows the pool without URLs.

### Patch Changes

- [#76](https://github.com/osbytes/reelsaw/pull/76) [`c3b33b4`](https://github.com/osbytes/reelsaw/commit/c3b33b437bb3f6914806472a653a3a9ed8877c82) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Ingest fails immediately when the worker disk cannot hold `MIN_FREE_DISK_MB` plus the source (instead of waiting 900 s and retrying). Uploads reserve their actual size, and the UI says Preparing rather than Downloading.

## 0.11.6

### Patch Changes

- [#74](https://github.com/osbytes/reelsaw/pull/74) [`eb5ee1f`](https://github.com/osbytes/reelsaw/commit/eb5ee1ff2579123cf98f966b713a599d71362458) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can turn the watermark off (or on) for one account from Users → Limits. Follow / Always / Never saves and applies on the next render; `reelsaw limits <email> --watermark always|never|follow` does the same.

## 0.11.5

### Patch Changes

- [#73](https://github.com/osbytes/reelsaw/pull/73) [`31561b7`](https://github.com/osbytes/reelsaw/commit/31561b7706d48d73dbd4f84c17d16d0a98dfb178) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clips are picked throughout the video instead of clustering in the first couple of minutes. Each map pass now looks at a short overlapping window, and a second pass only runs when the first picks leave a long uncovered stretch. Existing projects pick this up on re-analyze.

## 0.11.4

### Patch Changes

- [#69](https://github.com/osbytes/reelsaw/pull/69) [`f841d61`](https://github.com/osbytes/reelsaw/commit/f841d610280bd080f80c166574c81476f964464c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - OpenTelemetry is clearer to wire and works in the browser too: the server exports traces with explicit OTLP URLs/headers (Sentry destinations skip metrics), and when OTEL is on the web app gets the same public endpoint from `system.status` and sends browser traces. `SENTRY_DSN` stays separate from OTEL — set `OTEL_EXPORTER_OTLP_*` yourself.

## 0.11.3

### Patch Changes

- [#67](https://github.com/osbytes/reelsaw/pull/67) [`4ca10a5`](https://github.com/osbytes/reelsaw/commit/4ca10a5db563bcf4da39a8fb69791e135b847df2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - On hosted instances with Sentry or PostHog, "Report an issue" sends feedback through those channels instead of a zip download. Instance system info and recent errors stay available only for self-host and admins, so a hosted account cannot export another user's diagnostics.

## 0.11.2

### Patch Changes

- [#64](https://github.com/osbytes/reelsaw/pull/64) [`c093611`](https://github.com/osbytes/reelsaw/commit/c0936116cdf7f12563d75ccc993c49a78c9a4b3f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Transactional emails (verify, reset password, approved, waiting for approval) now send branded HTML with a clear button, plus the same links in plain text. No tracking.

- [#65](https://github.com/osbytes/reelsaw/pull/65) [`bbbae38`](https://github.com/osbytes/reelsaw/commit/bbbae387d6457283f58fac6141f304abfbdbc258) Thanks [@dillonstreator](https://github.com/dillonstreator)! - `pnpm stripe:setup` rebuilds `@reelsaw/shared` first so a stale shared build cannot miss exports like `billingPath`.

## 0.11.1

### Patch Changes

- [#62](https://github.com/osbytes/reelsaw/pull/62) [`673bd6d`](https://github.com/osbytes/reelsaw/commit/673bd6d0ad2bdbdff788868caa04bc840364f8d0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The image entrypoint now `chown`s a volume-mounted `DATA_DIR` (e.g. Railway) before dropping to `node`, so boot no longer fails with `EACCES` on `/data/uploads`.

- [#60](https://github.com/osbytes/reelsaw/pull/60) [`df7d4ab`](https://github.com/osbytes/reelsaw/commit/df7d4ab57a515bd128e28808623854c5b5929a40) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A budgeted batch loop (retention sweeps, purges) always makes one batch of progress before honouring its deadline, so a budget that is already spent when the loop starts cannot leave the cursor in place forever. Also fixes the timing-sensitive unit test that failed on a slow CI runner.

## 0.11.0

### Minor Changes

- [#53](https://github.com/osbytes/reelsaw/pull/53) [`1ac8156`](https://github.com/osbytes/reelsaw/commit/1ac815672b7ddd9c4e183302442c141aa05d5eb3) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Plans and billing for hosted instances (enterprise edition), a monthly minutes quota, and a watermark for accounts that are not admins.
  
  - `MAX_SOURCE_MINUTES_PER_MONTH` joins the quotas: minutes of source video per billing period (or UTC calendar month), with the usual refusal sentence and per-user override.
  - `WATERMARK_NON_ADMINS` (default on) burns `WATERMARK_TEXT` into the clips of non-admin accounts through the caption file; admins switch it per user on the Users page (Limits), a paid plan removes it, and each clip records whether it was rendered with it. **Upgrade:** multi-user installs that do not want this set `WATERMARK_NON_ADMINS=false` (Settings → System → Limits works without a restart).
  - `REELSAW_EE=true` with `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` loads `apps/server/src/ee` (its own licence, see LICENSING.md): Free / Starter / Creator / Pro plans (priced like OpenShorts Cloud) whose limits sit between the instance setting and the admin's per-user override, Stripe Checkout and Billing Portal from Settings → Billing, `get_billing` / `billing_checkout_url` over MCP, `reelsaw billing` on the CLI. Webhooks are recorded and queued in one transaction and the account's row is rewritten from Stripe by a job, so late, duplicate or reordered events converge; a daily reconcile and `reelsaw billing sync` repair lost ones. `pnpm stripe:setup` creates the Stripe objects; `pnpm stripe:mock` stands in for Stripe in development. Self-hosted installs are unchanged apart from the two settings above.
  - Free-tier abuse guards, off unless set: `MAX_SIGNUPS_PER_IP_PER_DAY`, `BLOCK_DISPOSABLE_EMAILS`, one account per real mailbox (`user.email_key`, backfilled by the migration), `MAX_REQUESTS_PER_MINUTE` / `_HOUR` on changes per account, and hourly abuse flags on the Users page (`reelsaw abuse`). `TRUST_PROXY` (default on) names which headers carry the client address.
  - Optional Sentry (`SENTRY_DSN`) and PostHog (`POSTHOG_KEY`, `POSTHOG_HOST`) across server and web: errors from boot, 5xx API calls, final job failures and render crashes; product events for sign-ups, projects, billing and abuse flags; page views and a few actions in the browser. Off unless set.

- [#51](https://github.com/osbytes/reelsaw/pull/51) [`defa355`](https://github.com/osbytes/reelsaw/commit/defa355d665e4d95dbf9a4ae5f2f6faf8b830269) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Refine after transcription (name fixes, filler removal, the filler model pass, and scene cuts) is opt-in: turn steps on per project or in Project defaults, with instance ceilings under Settings → System → Pipeline.
  
  **Upgrade:** `TRANSCRIPT_CORRECTION`, `DISFLUENCY_REMOVAL`, `DISFLUENCY_LLM` and `REFINE_SCENES` now default to off (was on). New projects skip refine unless you open those gates and opt the project in. To keep the old behaviour, set them to `true` in `.env` or Settings → System → Pipeline, and turn the matching toggles on in Project defaults.

### Patch Changes

- [#57](https://github.com/osbytes/reelsaw/pull/57) [`57528f2`](https://github.com/osbytes/reelsaw/commit/57528f2e3de406830e0d0372670325a865a9bf2d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - CTC forced alignment no longer treats adjacent repeated letters without a blank as a valid path, so words like "hello" get legal letter spans at cut seams.

## 0.10.2

### Patch Changes

- [#47](https://github.com/osbytes/reelsaw/pull/47) [`8dfaeae`](https://github.com/osbytes/reelsaw/commit/8dfaeaec5d637997ba22b9ed1751ad538705711f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Add `local-qwen14-cpu` / `local-qwen14-gpu` bench profiles and `bench:e2e --gpu` (NVENC for the isolated bench app). Fix the e2e driver on Windows (`fileURLToPath` for the repo root cwd, resolve `docker.exe` via `where.exe`).

## 0.10.1

### Patch Changes

- [#45](https://github.com/osbytes/reelsaw/pull/45) [`eeb1933`](https://github.com/osbytes/reelsaw/commit/eeb1933b430ccbd3a7d6e7ef317aba4887a76da7) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Link downloads now report progress ("Downloading 42% of 1.57GiB at 5.00MiB/s"): yt-dlp's `--print-json` silenced its progress lines, and they were read from the wrong stream. "Download finished in …" shows the download's wall clock instead of the video's length, and processing-time estimates no longer learn from the bad ingest samples.

## 0.10.0

### Minor Changes

- [#41](https://github.com/osbytes/reelsaw/pull/41) [`c48aeb5`](https://github.com/osbytes/reelsaw/commit/c48aeb59469910235ece5b17da377997cf0db14d) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Use the GPU where it pays. `docker-compose.gpu.yml` hands an NVIDIA card to Speaches (`SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cuda`, so `faster-whisper-large-v3` transcribes faster than `small` did on the CPU), to Ollama in a container, and to the app, where ffmpeg now encodes clips, intros and outros with `h264_nvenc` when `FFMPEG_ENCODER=auto` finds it at boot (VideoToolbox on a Mac outside Docker); a hardware encoder that fails mid-render falls back to libx264 for that clip. `ONNX_EXECUTION_PROVIDER` moves the face, text and alignment models to CUDA, CoreML or DirectML with a CPU fallback (CPU stays the default: measured faster on Apple silicon). Settings → System → Overview and the new `reelsaw machine` command show the GPU the process sees, the encoder in use and why, and where each on-device model runs.

- [#41](https://github.com/osbytes/reelsaw/pull/41) [`9324f80`](https://github.com/osbytes/reelsaw/commit/9324f80d74cd125fbc74656e7fe010e4949c2566) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The one-command installers (`install.sh`, `install.ps1`) now look at the machine before doing anything: RAM, an NVIDIA GPU and its VRAM, Docker's memory, free disk, an Ollama already running and the models it has, and the port. They print a plan and ask three questions (local Ollama or a hosted provider, which model, go ahead), install Ollama when it is missing and you chose local, reuse a good model Ollama already has, pick the model by VRAM when a GPU serves it, move a busy port, and put Ollama, Speaches and the app on the GPU when the NVIDIA Container Toolkit is present. Hosted providers (OpenAI, Anthropic, Google, Groq, Vercel AI Gateway) are a choice in the same prompt. `REELSAW_YES=1` takes the proposed answers, `REELSAW_DRY_RUN=1` prints the plan and stops; re-running upgrades an existing install.

### Patch Changes

- [#44](https://github.com/osbytes/reelsaw/pull/44) [`9ba8669`](https://github.com/osbytes/reelsaw/commit/9ba86694b3447e8f34b3f26192bdc7c82fdd9209) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Detect the GPU on Docker Desktop (WSL2) via `/dev/dxg` when `nvidia-smi` and `/dev/nvidia0` are missing, document that Windows `.env` must use `;` in `COMPOSE_FILE` (a colon is the drive-letter separator), and keep `pnpm docs:gen` defaults as POSIX paths on Windows.

## 0.9.0

### Minor Changes

- [#35](https://github.com/osbytes/reelsaw/pull/35) [`21cc500`](https://github.com/osbytes/reelsaw/commit/21cc5006a428ec4b56247f6865f579ab38ca8390) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can change instance settings without a restart: sign-up mode, email verification, captcha, legal links, per-account quotas, upload limits, retention, the stall watchdog, the update check and whether /api/health shows machine numbers. The environment stays the default; what an admin saves under Settings → System, with `reelsaw settings` or the `set_instance_settings` MCP tool overrides it for every process within seconds, is validated as a whole and audited. The Settings page is split into Account and System tabs, and project cards keep one height whatever the title length.

## 0.8.0

### Minor Changes

- [#32](https://github.com/osbytes/reelsaw/pull/32) [`af4f780`](https://github.com/osbytes/reelsaw/commit/af4f78091503582bfa6435d96c82dd0e2e8a959e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins are told when a newer Reelsaw is published: Settings → System shows the release with its notes link and the one command to upgrade, and the account menu marks Settings with the waiting version (a dot on the account button) until it is done. Settings itself moved from the top bar into the account menu. `reelsaw version` prints the same from the shell and the `check_for_update` MCP tool returns it to agents. The app asks GitHub's releases API every 6 hours, sending nothing but the request; `UPDATE_CHECK=false` turns it off.

### Patch Changes

- [#34](https://github.com/osbytes/reelsaw/pull/34) [`37f2f59`](https://github.com/osbytes/reelsaw/commit/37f2f591b489f98a96efadb03b243503c03406e9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Escape the caption file path correctly for ffmpeg, so renders work when the data directory contains a colon, quote or backslash. YouTube links are only recognised on youtube.com and its subdomains, and a vulnerable esbuild pulled in by drizzle-kit is overridden.

## 0.7.0

### Minor Changes

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`c6fe768`](https://github.com/osbytes/reelsaw/commit/c6fe768e6f515ce16c5412412528e0e027500005) Thanks [@dillonstreator](https://github.com/dillonstreator)! - MCP tools say what they return, whether they run in the background and which neighbouring tool to use instead, every input is described, and three new tools (with tRPC and CLI twins) fill gaps: `delete_clip` (restorable with `restore_clip`), `update_project` (title and settings without re-running anything) and `rename_bumper`; a partial caption style on a clip or project no longer resets the other style fields to their defaults.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`dda5789`](https://github.com/osbytes/reelsaw/commit/dda5789d01bc791e3c1bc5396e8777ab4094554f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Deleting a project can be undone for 7 days, and re-picking moments keeps every clip you made or edited, replacing only untouched AI picks (which can be restored too); the same through MCP (`restore_project`, `restore_clip`) and the CLI (`reelsaw deleted`, `restore`, `restore-clip`, `purge`).
  
  **Upgrade:** deleted projects now keep their files for `DELETED_RETENTION_DAYS` (default 7; 0 keeps them forever) before the hourly sweep removes them, so disk is freed a week after a delete instead of at once; lower the setting to free it sooner. The migration adds `deleted_at` to projects and clips and `edited_at` to clips. Clips edited before this release are only recognised as edited by their framing, style or intro/outro choice.

### Patch Changes

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`e76241c`](https://github.com/osbytes/reelsaw/commit/e76241ce41181383359991e5630cc748aaa6a666) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Boot checks the models that will actually run (including an admin override), rejects transcription models without word timestamps, and the installer picks the language model by RAM, verifies the container can reach a host Ollama, and the image pins yt-dlp and every model weight by checksum.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`0b3fefb`](https://github.com/osbytes/reelsaw/commit/0b3fefb14d446e4886e56900577ce711178a8db7) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Evals: real-speech transcription cases graded against human captions (raw and normalised WER, names-only error rate) and 48 disfluency cases from caption diffs, with a caption-diff tool to make more.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`8589266`](https://github.com/osbytes/reelsaw/commit/8589266810bb065ff02001e7f51c62eb14be2e51) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Caption lines now stay up long enough to read (0.3 s per word, 20 characters per second), face-size thresholds adapt to non-16:9 sources, and the renderer and preview share one crop and font definition.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`57087ee`](https://github.com/osbytes/reelsaw/commit/57087eea86f8425ed363ffecd1f431c77eb7515e) Thanks [@dillonstreator](https://github.com/dillonstreator)! - CI now runs every stack-free test and the offline eval suites, and `eval --update` refuses to record regressions without a stated reason.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`8b64662`](https://github.com/osbytes/reelsaw/commit/8b646628ba8a021cbbd82dc386c5357f39b5bb86) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Jobs are served fairly between accounts (someone with nothing in flight goes ahead of another account's backlog), model calls are capped per provider across all processes (`PROVIDER_CONCURRENCY`, self-hosted default 2), new per-user limits `MAX_LIVE_JOBS_PER_USER`, `MAX_RERENDERS_PER_HOUR` and `MAX_STORAGE_MB`, and usage now shows reported LLM cost, minutes transcribed and rendered-clip storage (`reelsaw usage`, `reelsaw limits <email>`).
  
  **Upgrade:** migration adds `llm_usage.cost_usd`, `clips.output_bytes` and the `stt_usage` table; the new limits default to 0 (unlimited), so a single-operator install behaves as before. Jobs already queued carry no owner and are not counted toward the new limits. A self-hosted model now serves at most 2 calls at once across all workers unless `PROVIDER_CONCURRENCY` says otherwise.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`93084c7`](https://github.com/osbytes/reelsaw/commit/93084c7195bab2937b6f2e6d73ab84d161ee8835) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The framing eval now scores non-podcast sources (multi-camera talk show, screencast with a corner webcam, 4:3 interview, hands-only POV, vertical short) against hand-labelled shot windows.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`527c02e`](https://github.com/osbytes/reelsaw/commit/527c02e941cedf754dff51be0090f64dac5758a0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Docs: every environment variable, operator CLI command and eval suite is now documented from generated tables (docs/CONFIG.md, both .env.example files; `pnpm docs:check`), with a "Settings and precedence" section and corrected install, heartbeat and boot-check notes.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`d3fb6f7`](https://github.com/osbytes/reelsaw/commit/d3fb6f7f5a1d09e30ee941715ceff4c1f51a1ba8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Harden ingress: streamed uploads are size-capped, link sources must be public http(s) URLs, the first sign-up race cannot create two admins, and admin-entered provider keys are scrubbed from issue reports.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`abca9fe`](https://github.com/osbytes/reelsaw/commit/abca9fef6d3cd50f5235092b92285f7f2ff29ff0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Changing a project's style, intro/outro or source-text setting while clips finish rendering no longer risks a stalled or failed request, and project limits now hold when several projects are created at once.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`8870362`](https://github.com/osbytes/reelsaw/commit/88703621943f8ab340a4b3970507abc4e5e60723) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Add overlay and active-speaker eval fixtures from talk-show, street-interview, screencast, sport, podcast and news sources.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`bb8a613`](https://github.com/osbytes/reelsaw/commit/bb8a6133226731545f4bbd2a87e1aab693761170) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Auto mode now drops weak clips relative to the run's own scores (median − MAD, floor 25) instead of a fixed 45, so switching the judge model no longer empties projects or keeps every clip; the pairwise pass places the top 3 reliably and a separate judge model can be set.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`5a52f25`](https://github.com/osbytes/reelsaw/commit/5a52f25398e0d3baf22c269d779a15f9420b1e11) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The scenes eval now covers bright football highlights, a news package and a multi-camera studio show, and can exclude dissolves and wipes from the hard-cut metric.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`d744ee1`](https://github.com/osbytes/reelsaw/commit/d744ee1e053becb6ea24855d11f5c2ab5e8b8404) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The selection eval now measures whether clip picking finds the moments podcast creators cut their own shorts from (creator-picks cases, labelled with the new `creator-spans` tool).

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`6f61191`](https://github.com/osbytes/reelsaw/commit/6f611913bc24ec1e5eb8b974ea3c59c697854b73) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Filler removal, name fixes and CTC cut alignment now skip with a plain-language notice for non-English transcripts instead of running silently, and text matching and sentence splitting understand non-Latin scripts.

- [#29](https://github.com/osbytes/reelsaw/pull/29) [`4ad75e2`](https://github.com/osbytes/reelsaw/commit/4ad75e2c868227f02b294ca713d8fce423eab00a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The web app loads faster and plays smoother: pages and the command palette load on demand, the clip editor and transcript no longer re-render every frame during playback, and the interface follows the layout-shift, loading-state and scrolling rules more closely.

## 0.6.0

### Minor Changes

- [#24](https://github.com/osbytes/reelsaw/pull/24) [`84251b0`](https://github.com/osbytes/reelsaw/commit/84251b0293efbacfa7c6fa971a601af9ab5ef355) Thanks [@dillonstreator](https://github.com/dillonstreator)! - MCP over stdio: `reelsaw mcp` serves the same tools as `/api/mcp` to clients that launch a command instead of calling a URL with a header (Claude Desktop without OAuth, Cursor's stdio entries, registry checks). It forwards every call to a running instance (`REELSAW_URL`, default the app in the same container, with `REELSAW_API_KEY`), so it needs no database or models. Settings → API keys and MCP shows the `docker exec` config next to the HTTP ones.

### Patch Changes

- [#25](https://github.com/osbytes/reelsaw/pull/25) [`711893f`](https://github.com/osbytes/reelsaw/commit/711893fe301cc75662b025cb515175a8778c29e0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - New logo: a sliced "r" monogram on the accent colour, with the wordmark split as reel/saw. Favicon, app icons and the README lockup are redrawn to match.

## 0.5.0

### Minor Changes

- [#18](https://github.com/osbytes/reelsaw/pull/18) [`6cc7335`](https://github.com/osbytes/reelsaw/commit/6cc7335027a90eeb539165ff61b462c8eaf3f363) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A speaker beside an app screen or title card is framed as a stack: that content on top, the speaker below

### Patch Changes

- [#21](https://github.com/osbytes/reelsaw/pull/21) [`af880e7`](https://github.com/osbytes/reelsaw/commit/af880e74f5a12314c8456ab0e26afedd51fc3d5b) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Clips end on a complete thought. A clip that stopped mid-sentence ("…and you're now so | different") now finishes the sentence when it is within 8 seconds (or steps back to the previous one), and starts at the beginning of a sentence when one is within 3 seconds. Sentence ends come from punctuation, pauses and capital letters after a word that is not a connector like "and" or "so". Your manual edits are never moved. See docs/SELECTION.md.

- [#18](https://github.com/osbytes/reelsaw/pull/18) [`6f809da`](https://github.com/osbytes/reelsaw/commit/6f809da1177f71c23ef9313d229b0a2fa7fe9e3c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Framing is no longer affected by how many clips render at once

- [#23](https://github.com/osbytes/reelsaw/pull/23) [`1d7d51c`](https://github.com/osbytes/reelsaw/commit/1d7d51c56fd0aae1acda259a7ccbe2f9d3a814b2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - A cut you made is always applied. When the seam check could not re-find the removed words in the audio (a sentence said twice, "seven" heard as "7"), the cut used to be dropped silently. It is now matched by its position in the audio instead of by text, with numbers, case and punctuation ignored, and if the seam still cannot be confirmed the cut is applied where you set it and marked "▲ cut unverified" on the clip card, in the editor's cuts tab and next to the cut in the transcript, with a notice in the activity feed. Automatic cuts that cannot be verified are still kept in the audio and reported.

- [#20](https://github.com/osbytes/reelsaw/pull/20) [`da61f0a`](https://github.com/osbytes/reelsaw/commit/da61f0a224981dc24acf7852f690e9ea54f60368) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Fix a deadlock when several clips finish rendering at once (a batch re-render): the render completion no longer fails and re-renders from scratch, and transactions aborted by a lock conflict are retried.

## 0.4.0

### Minor Changes

- [#17](https://github.com/osbytes/reelsaw/pull/17) [`888c6c3`](https://github.com/osbytes/reelsaw/commit/888c6c3d088cd5a7b63a3f2a2ee9b18cfc723fd4) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Select clips on the project page and act on them together: re-render, export a zip of just those clips, copy their titles and captions, set their intro/outro, or retry the failed ones (also `rerender_clips` and `export_project` with `clipIds` over MCP, `reelsaw rerender <clipId…>`, and `?clips=` on the export URL). Clip cards are quieter: one muted summary line (framing, intro/outro, cuts) instead of four rows, Edit and Download up front and everything else in a ⋯ menu. The select-all controls now sit in the sticky "Clips" header.

- [#16](https://github.com/osbytes/reelsaw/pull/16) [`3e55f1f`](https://github.com/osbytes/reelsaw/commit/3e55f1f0b3cb90f66035c68710566886a742ce3c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Logs now explain what the pipeline decided and why. Every project event (run started, stage completed, clip done or failed) is a log line with the project, run and job ids; at `debug` you also get the moments chosen with their scores, the layout per section and why, each cut accepted or rejected, the ffmpeg commands, framing and bumpers used. API requests, sign-ins, admin actions and MCP tool calls are logged with a request id that is returned in the `x-request-id` header and carried through tRPC errors. `LOG_LEVEL` accepts per-module levels (`info,render=debug`), and `reelsaw log-level render=debug --for 15m` (or Settings, System, Log level) changes them on a running install and puts them back by itself. `reelsaw logs <id>` can filter by time, level and module, issue reports include the level in force, and browser errors are reported to the server log.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`1fe6a36`](https://github.com/osbytes/reelsaw/commit/1fe6a36fa01fa1e285ed04b3aabc8966ffc29981) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Bound background work and growth: progress ticks are live-only (sent over Postgres NOTIFY, never stored); `EVENT_RETENTION_DAYS` (90), `LLM_USAGE_RETENTION_DAYS` (180) and `ADMIN_EVENT_RETENTION_DAYS` (365) prune old rows daily in batches; deleted fixes beyond 200 are archived instead of dropped; clip diagnostics are capped; transcript edits write only the columns that changed; the storage sweep looks up directories 1,000 at a time with bounded parallel `stat` and resumes from a cursor after a time budget; retention and the library purge use keyset batches; job lookups use `singleton_key`.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`ba6ada9`](https://github.com/osbytes/reelsaw/commit/ba6ada9e3983dd569713ec241e923f8156cd5550) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Projects and the admin user list load in pages instead of all at once. The Projects page loads 24 at a time as you scroll (or with Load more), shows the true totals in its header, and only polls the projects that are processing. The admin Users page searches on the server (with `%` and `_` matched literally), shows "Showing 50 of N" and loads more on request. The `list_projects` MCP tool takes `limit` and `cursor` and returns `nextCursor` and `total`.

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`8578922`](https://github.com/osbytes/reelsaw/commit/8578922a11425aca0d5168543541a1e4c159f395) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Large projects open and stay fast. The project page no longer re-downloads the whole transcript on every event: the project and its transcript load separately, and each event refreshes only what it changed. The Activity panel replays the last 300 events (configurable with `EVENT_REPLAY_LIMIT`) and shows "Showing the last 300 of N", with a "Load older" button. The command palette (⌘K) now searches on the server as you type (typo-tolerant, best matches first), so it finds every project and clip however many you have, and the MCP server gains `search_clips`. `get_project` returns only a transcript summary; use `get_transcript` for the text. Adds the `pg_trgm` extension and search indexes (migration 0028).

### Patch Changes

- [#11](https://github.com/osbytes/reelsaw/pull/11) [`dc445b7`](https://github.com/osbytes/reelsaw/commit/dc445b70ffd451b0d3fac0513a4a8a00f5f835e0) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Add indexes for the common list, reconcile and retention queries (`projects (user_id, updated_at)`, `projects (status)`, partial retention indexes, `uploads (user_id)`), plus a scale audit (`docs/specs/scale.md`), a Scale section in the engineering principles and a seed script for measuring at 1,000 projects.

## 0.3.1

### Patch Changes

- [#8](https://github.com/osbytes/reelsaw/pull/8) [`d79cf11`](https://github.com/osbytes/reelsaw/commit/d79cf112290aadcd4a73e1f85168fd42db6bcf82) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Pages, lists, pickers and settings now show placeholder skeletons shaped like their content while loading, instead of flashing "No activity yet" or "Nothing found" before the data arrives.

- [#8](https://github.com/osbytes/reelsaw/pull/8) [`de341bb`](https://github.com/osbytes/reelsaw/commit/de341bba6bddda2970cc45dc778cbc9c22493a37) Thanks [@dillonstreator](https://github.com/dillonstreator)! - The Users page is now one aligned list with usage per account, sortable columns and a usage window picker, and the Limits dialog shows how much of each limit an account has used.

## 0.3.0

### Minor Changes

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Library page for intros and outros: drop several files at once (duplicates are detected), click a thumbnail to view it enlarged, see which projects and clips use each item, remove with Undo. Pickers everywhere are a searchable combobox with thumbnails, and images get a 3 s default that can be changed per item or per use. New projects can pick their intro and outro up front, project cards show the assets in use as small fanned cards, and ⌘K and the New project menu offer library shortcuts. Toasts now use sonner.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`1241496`](https://github.com/osbytes/reelsaw/commit/12414961d9696616acf3e9979d15963fd233db57) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Intro and outro library: keep several videos or images (PNG or JPG, shown 1 to 10 s) and choose which one new projects start with. Each project can use the default, none, or a specific one, and a single clip can opt out; changes re-render only when confirmed. The editor shows what a clip adds around its source range, and clip cards say when an intro or outro was skipped.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Agents and operators can manage intros and outros: MCP tools `list_bumpers`, `add_bumper` (from a URL or an upload), `set_default_bumper`, `remove_bumper`, `restore_bumper`, `bumper_usage`, `set_project_bumpers` and `set_clip_bumpers`; `get_project`, `get_clip` and `create_project` carry intro/outro state. CLI: `reelsaw bumpers …`, `reelsaw project-bumpers`, `reelsaw clip-bumpers`.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`6a53f17`](https://github.com/osbytes/reelsaw/commit/6a53f1706eb03c180703c19004db7ea554a560b9) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Choose an intro and outro per clip: each clip can follow the project, use none, or use a specific library item, per slot. Set it in the editor, from a clip card, or for several selected clips at once on the project page. Replaces the all-or-nothing opt-out.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Command palette (⌘K): rows show status, length, clip counts and age; → or Tab on a project or clip opens its actions (open, export, resume, retry failed clips, re-run refine, delete, edit, re-render, download) with confirms for the destructive ones. "Retry all failed clips" and "Resume failed projects" appear when there is something to retry. A pasted link that matches an existing project offers to open it, and a list of links starts one project each.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`8e99bb4`](https://github.com/osbytes/reelsaw/commit/8e99bb466c160e68c29325a3aafd6bfb851fd77a) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Intro and outro videos: upload one of each in Settings and every clip of new projects is rendered as intro + clip + outro in a single encode. Bumpers are fitted to vertical with a blurred background, normalised once per asset, and an unusable one is skipped with a plain-language event instead of failing the clip. Exports gain `rendered_duration_sec`.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Processing time is measured per run. Every retry, re-render, refine or re-analyze starts an explicit run (`run.started`), stage and project events carry their own durations, and the activity feed groups history by run with its reason and total. A clip re-rendered hours after a project finished now reports its own time instead of the time since the first run. Expected-time estimates, Processing times and `reelsaw status` read the same runs.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Storage: superseded render generations and expired sources are removed from the scratch directory too, uploads are released when a project is deleted, and an hourly sweep removes orphaned files. `reelsaw storage` reports unique, leftover, duplicate-source and expired bytes; `reelsaw storage sweep [--dry-run]` runs the sweep on demand. Removed intro/outro assets that nothing references are purged after 30 days.

### Patch Changes

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02a9343`](https://github.com/osbytes/reelsaw/commit/02a9343f1e42f76e260c1a7db82024cd38033ec8) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Space in the clip preview plays that clip instead of the hidden source video. The "jobs paused" chip sits left of the search box so it no longer shifts the header when it appears. Changing an intro/outro length in the editor now enables Save & re-render.

- [#5](https://github.com/osbytes/reelsaw/pull/5) [`02633c7`](https://github.com/osbytes/reelsaw/commit/02633c732117f2abffe262962d65b08ab575768f) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Windows: a PowerShell one-line installer (`install.ps1`) next to the bash one. Both installers are now served straight from the repository (raw.githubusercontent.com) instead of a gist.

## 0.2.0

### Minor Changes

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Accounts and roles: the first account is the admin; `SIGNUP_MODE=open|approval|closed` controls sign-ups (approval holds new accounts on a "Waiting for approval" page until an admin approves them on the new Users page). Admins can suspend, reinstate, promote and remove accounts; `reelsaw users|approve|make-admin` from the shell. Optional email (`EMAIL_DRIVER=smtp|resend`) sends approval notices, password resets and verification.
  
  **Upgrade:** existing accounts stay approved; the oldest becomes the admin. `ALLOW_SIGNUP=false` still means `closed`.

- [#4](https://github.com/osbytes/reelsaw/pull/4) [`4142149`](https://github.com/osbytes/reelsaw/commit/41421494ef06858ab96f4e049b830763cf9ee6c2) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Admins can switch models and connect providers without a restart. Settings → System → Models has pickers for the language, transcription and alignment models; each opens provider-first: pick a provider, and if it has no key or server URL yet, enter it right there (stored encrypted with a key derived from `BETTER_AUTH_SECRET`; never shown again; `.env` stays the default) and its models appear. Cloud vendors are listed live (OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, the Vercel AI Gateway with prices); self-hosted Ollama or Speaches show what is installed and download missing models with a progress bar. Saving a key tries it first (lists the provider's models); saving a model verifies it (key, server, word timestamps for transcription). Overrides live in the database so every process picks them up within seconds; a stage that is already running finishes with the model it started with. API: `admin.providers.get/set/clear`, `admin.models.get/catalog/set/test/pull`; changes go to the admin event log.

- [#3](https://github.com/osbytes/reelsaw/pull/3) [`b128b11`](https://github.com/osbytes/reelsaw/commit/b128b11da85c1d62cb52a699dd26ac304369903c) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Expected vs actual processing time: the project page shows elapsed and expected time for the running stage, the activity feed says how long each stage took against its expectation, and Settings → System → Machine (admins) has a per-stage expected vs actual table across recent projects. Expectations start from measured defaults (README, "What to expect") and become the median of your own finished projects that ran with the same models; there is no calibration step. Also a proper not-found page for missing projects and clips.
  
  For contributors: `pnpm eval ... --matrix eval/bench/models.json` runs the suites once per model profile (env overrides on `.env`; cloud models through the Vercel AI Gateway, `gateway:<vendor>/<model>`) with latency, tokens and cost per profile side by side, and `pnpm bench:e2e` times the real pipeline per stage in an isolated compose stack, with `--steps refine,analyze` to re-run just those steps on one transcript. The first result set is in `eval/bench/results/2026-10-17-initial/`.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Running Reelsaw for many people: quotas (`MAX_PROJECTS_PER_USER`, `MAX_SOURCE_MINUTES_PER_DAY`, `MAX_NEW_PROJECTS_PER_HOUR`, per-user overrides on the Users page) with plain-sentence refusals; usage per user (projects, source minutes, clips, model calls and tokens, stored bytes); retention (`SOURCE_RETENTION_DAYS`, `CLIP_RETENTION_DAYS`, "fetch again" on the project); captcha on sign-up/sign-in (`CAPTCHA_PROVIDER`); `YTDLP_PROXY` / `YTDLP_COOKIES_FILE` and plain-words download failures; `TERMS_URL` / `PRIVACY_URL`; MCP over OAuth 2.1 (`MCP_OAUTH=true`) so claude.ai and Claude Desktop connectors sign in with the browser. All off by default.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Agents can drive Reelsaw over MCP: `POST /api/mcp` (Streamable HTTP) with tools to create projects, wait for them, read timed transcripts, edit, re-render and download clips. API keys (Settings → API keys and MCP) authenticate MCP, tRPC, uploads and media downloads; the page shows the Claude Code and mcp.json config.

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Settings are per person: everyone gets Account (name, password), Project defaults (vocabulary, instructions, language, clip length, pauses, caption style; applied to every new project, the new-project form starts from them) and API keys. Machine configuration and resource meters are shown to admins only, and `GET /api/health` includes them only for admins (or with `HEALTH_DETAILS=true`).

### Patch Changes

- [`1fc2886`](https://github.com/osbytes/reelsaw/commit/1fc28860f5c06cec3c57d4b8633d8f55feda2735) Thanks [@dillonstreator](https://github.com/dillonstreator)! - Project licensed under AGPL-3.0 with a DCO sign-off for contributions; releases are versioned with changesets (`docs/RELEASING.md`), CI typechecks and builds every PR.
