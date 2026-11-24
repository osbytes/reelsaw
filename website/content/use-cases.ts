import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import type { Faq, Link, Section, UseCase } from "./types";

const UPDATED = "2026-11-22";

const README: Link = { href: "https://github.com/osbytes/reelsaw#readme", label: t(msg`Reelsaw README: selection, reframing, captions`) };
const LAYOUTS: Link = {
  href: "https://github.com/osbytes/reelsaw/blob/main/docs/LAYOUTS.md",
  label: t(msg`Reelsaw layouts reference (webcam tiles, fit, crops)`),
};

/** How Reelsaw frames 16:9 gameplay in 9:16. Shared by every gaming page so the claims stay the same. */
const GAMEPLAY_FRAMING: Section = {
  heading: t(msg`How 16:9 gameplay fits a vertical clip`),
  bullets: [
    t(
      msg`Facecam in an OBS scene: Reelsaw finds the webcam tile (a steady rectangle around your face) and stacks the clip: the gameplay on top at full width, your camera below at its own shape, enlarged. A flat band beside the tile is dropped from the top pane so the game fills it.`,
    ),
    t(
      msg`No facecam: the whole frame sits over a blurred copy of itself, so the HUD, minimap and the edges of the action stay in shot. 3D gameplay whose camera turns stays whole instead of chasing motion that is everywhere.`,
    ),
    t(
      msg`Your HUD is not mistaken for subtitles: on-screen text that hugs the sides of the frame (menus, player lists, kill feeds) is left alone when Reelsaw hides burned-in captions.`,
    ),
    t(
      msg`Want a tighter crop? Right-click the picture in the editor and set a crop box on the source, then 'Use for all clips' copies it to every clip of the stream, since an OBS layout does not change mid-stream.`,
    ),
    t(
      msg`Game sound is content: when Reelsaw shortens pauses it only removes quiet gaps. A gap full of gunfire, music or engine noise stays, and a clip that is mostly action without speech keeps its timing.`,
    ),
  ],
};

/** The limit every gaming page states: moments are picked from speech. */
const NEEDS_SPEECH: Faq = {
  q: t(msg`Does it work on gameplay with no commentary?`),
  a: t(
    msg`No. Reelsaw picks moments from the transcript, so it needs someone talking: your commentary, party or voice chat, or a streamer reacting. A capture with only game audio fails at transcription with a clear message instead of producing random clips. Turn on mic audio in your capture settings, or clip the stream VOD where you were talking.`,
  ),
};

const COST_PARAGRAPH = t(
  msg`Self-hosted Reelsaw is free software: no plan, no minute meter, no watermark, so an eight-hour stream costs your electricity or, with cloud models, those vendors' per-minute prices with no markup. Hosted at app.reelsaw.com: your first video is free up to 60 minutes (a longer one gets its first 60 minutes clipped and the rest when you upgrade), then 20 minutes a month with a watermark; Starter is $12 a month for 100 minutes, Creator $29 for 300 and Pro $59 for 750, metered in minutes of source video and never per clip.`,
);

export const USE_CASES: UseCase[] = [
  {
    slug: "gta-6-clips",
    nav: t(msg`GTA 6 clips`),
    hint: t(msg`launch streams and captures`),
    updated: UPDATED,
    metaTitle: t(msg`GTA 6 AI clipping: turn streams and captures into Shorts`),
    metaDescription: t(
      msg`Turn GTA 6 streams, VODs and console captures into vertical TikToks and Shorts with AI: facecam stacked under the gameplay, word-level captions, no per-clip credits.`,
    ),
    h1: t(msg`GTA 6 AI clipping: turn your streams and captures into vertical clips`),
    intro: [
      t(
        msg`GTA 6 came out on 19 November 2026 on PlayStation 5 and Xbox Series X|S, and the clips came with it: CNBC counted 125.5 million hours of GTA VI watched on Twitch, YouTube and Kick in the first 24 hours. Every one of those hours is a source for TikToks, Shorts and Reels, and most of it is long, loud and mostly the same three minutes of driving.`,
      ),
      t(
        msg`Reelsaw is an open-source AI clipper. Paste a Twitch or YouTube VOD link (or upload a capture) and it transcribes what you said, has a language model pick the moments worth posting, stacks your facecam under the gameplay in 9:16, burns in word-level captions and renders the clips. It runs free on your own machine, or hosted at app.reelsaw.com.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`Where GTA 6 footage comes from`),
        bullets: [
          t(
            msg`Stream VODs: a Twitch, YouTube or Kick broadcast with your voice and usually a facecam. The best source: you were reacting out loud, and the link is all Reelsaw needs.`,
          ),
          t(
            msg`Capture card or OBS recordings: the console runs into a PC and OBS records the game, your mic and your camera. Same as a VOD, at the quality you recorded.`,
          ),
          t(
            msg`Console captures: the PS5 Create button or the Xbox capture. No facecam, and voice only when the console's capture settings include your mic. Copy them off the console (USB or the console's app) and upload the file.`,
          ),
        ],
      },
      {
        heading: t(msg`How to turn a GTA 6 stream into TikToks`),
        bullets: [
          t(
            msg`Paste the VOD link, or upload the recording. A link works for anything yt-dlp downloads; a subscriber-only VOD needs downloading from your dashboard first.`,
          ),
          t(msg`Add Jason, Lucia, Leonida, Vice City and your friends' names to the vocabulary, so transcription spells them right in the captions.`),
          t(msg`Optionally tell the selector what you want: 'chases and funny fails, skip story cutscenes' keeps spoilers out of your feed.`),
          t(
            msg`Leave framing on auto. Reelsaw transcribes, chunks the stream at long pauses so hour five is read as carefully as minute five, collects every standalone moment, then ranks them head to head.`,
          ),
          t(
            msg`Review the clips as they render: trim on the word, change the layout of any section, edit the hook and captions, then download them or the whole zip with a paste-ready caption per clip.`,
          ),
        ],
      },
      GAMEPLAY_FRAMING,
      {
        heading: t(msg`What makes a GTA 6 moment work as a short`),
        bullets: [
          t(
            msg`A reaction you said out loud: the first look at Vice City, a heist that falls apart, a chase that ends in the sea. Reelsaw ranks on the words, so the moment needs you talking over it.`,
          ),
          t(
            msg`A setup and a payoff inside 60 seconds: the selector scores each candidate on hook, value, flow and shareability, and drops weak picks relative to the rest of the stream rather than filling a quota.`,
          ),
          t(msg`Clean starts: clips start on a sentence, so the first second is a hook rather than half a word.`),
          t(
            msg`No spoilers in the hook: story beats from launch week get reported. Tell the selector to skip cutscenes, or delete the clip; deleted clips can be restored for a while.`,
          ),
        ],
      },
      {
        heading: t(msg`What a launch-week stream costs to clip`),
        paragraphs: [COST_PARAGRAPH],
      },
      {
        heading: t(msg`What Reelsaw does not do`),
        bullets: [
          t(msg`It does not clip live: it works on the VOD or recording once the stream is over.`),
          t(msg`It does not clip footage with nobody talking (see the questions below).`),
          t(msg`It does not read Twitch chat or clip counts; the picks come from what was said.`),
          t(
            msg`It does not post for you: the export zip carries paste-ready text, a YouTube Data API body and a TikTok post body per clip, and share links a scheduler can fetch.`,
          ),
          t(msg`It does not record the game. Use OBS, a capture card or the console's own capture.`),
        ],
      },
    ],
    faqs: [
      NEEDS_SPEECH,
      {
        q: t(msg`Can I clip a GTA 6 stream from Twitch automatically?`),
        a: t(
          msg`Reelsaw clips any VOD you hand it, and every step is an MCP tool and a webhook, so a script, n8n flow or AI agent can start a project when a new VOD appears and post the clips when they finish. It does not watch Twitch channels on its own. The n8n guide shows the same flow for new YouTube uploads.`,
        ),
      },
      {
        q: t(msg`Can I clip someone else's GTA 6 stream?`),
        a: t(
          msg`Only with permission: your own streams, streams you edit for, or a clipping campaign whose terms allow it. The footage and the voice belong to the streamer.`,
        ),
      },
      {
        q: t(msg`Will Rockstar take down GTA 6 clips?`),
        a: t(
          msg`Rockstar and Take-Two have long allowed gameplay videos, with rules about leaks, spoilers and monetization. Read Rockstar's current policy before you monetize; Reelsaw makes the clip, the rules about posting it are the publisher's and the platform's.`,
        ),
      },
      {
        q: t(msg`How long should a GTA 6 TikTok or Short be?`),
        a: t(
          msg`Most clips land between 20 and 60 seconds. Set the clip length per project or in your project defaults if you want longer cuts for YouTube or shorter ones for TikTok.`,
        ),
      },
    ],
    sources: [
      {
        href: "https://www.cnbc.com/2026/11/20/gta-vi-launch-streaming-content-economy.html",
        label: t(msg`CNBC: GTA VI's launch and the content economy (20 Nov 2026)`),
      },
      README,
      LAYOUTS,
    ],
    disclaimer: t(msg`Reelsaw is not affiliated with Rockstar Games or Take-Two Interactive. Grand Theft Auto and GTA are their trademarks.`),
  },
  {
    slug: "gta-rp-clips",
    nav: t(msg`GTA 5 and GTA RP clips`),
    hint: t(msg`long RP streams`),
    updated: UPDATED,
    metaTitle: t(msg`GTA 5 and GTA RP clips: turn 8-hour streams into Shorts`),
    metaDescription: t(
      msg`Clip GTA 5 and GTA RP streams into vertical TikToks and Shorts: long VODs read end to end, facecam stacked under the game, character names spelled right in captions.`,
    ),
    h1: t(msg`GTA 5 and GTA RP clips from streams that run eight hours`),
    intro: [
      t(
        msg`GTA RP is the hardest shape for an auto-clipper: a stream that runs all night, a dozen characters with made-up names, and the best moments buried in the middle of hour six. GTA 6 has the launch hype; GTA 5 roleplay servers are still where the long-running stories are.`,
      ),
      t(
        msg`Reelsaw reads the whole VOD, not just its start and end, picks the moments that stand on their own, and stacks your facecam under the gameplay in 9:16 with word-level captions.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`Eight hours, read end to end`),
        paragraphs: [
          t(
            msg`Language models rank what they see at the start and end of a long prompt better than what sits in the middle. Reelsaw chunks the transcript at long pauses with 20% overlap, collects every standalone moment per chunk in parallel, then pools and ranks them, so a scene in hour six competes on equal terms with the opening. There is no fixed clip count: a stream yields as many clips as it earns.`,
          ),
        ],
      },
      {
        heading: t(msg`Character names in the captions`),
        paragraphs: [
          t(
            msg`RP is full of names a speech model has never heard: characters, gangs, businesses, the server's own slang. Put them in the project's vocabulary (or your project defaults, once for every stream) and transcription is biased toward them, with a correction pass that fixes the rest. Every correction shows in the transcript, where you can accept or reject it.`,
          ),
        ],
      },
      GAMEPLAY_FRAMING,
      {
        heading: t(msg`Clips that stand on their own`),
        bullets: [
          t(
            msg`Each candidate is scored on hook, value, flow and shareability, and the top ten are compared head to head with positions swapped, so the ones you see first are placed reliably.`,
          ),
          t(msg`'Find clips about …' keeps only one storyline: a character's arc, a heist, a court case.`),
          t(msg`Instructions steer the picks: 'arguments and chases, not menu time or driving to the next scene'.`),
          t(msg`Clips start and end on sentences, and you can trim to the word or make a new clip from any time range in the editor.`),
        ],
      },
      {
        heading: t(msg`What an eight-hour stream costs`),
        paragraphs: [
          COST_PARAGRAPH,
          t(
            msg`An eight-hour stream is 480 source minutes: more than a hosted Creator month. If you know where the good scenes are, pick just those ranges before anything downloads: only the ranges are downloaded, transcribed and counted against your minutes. Streamers who clip whole streams every night are the people self-hosting is for.`,
          ),
        ],
      },
    ],
    faqs: [
      NEEDS_SPEECH,
      {
        q: t(msg`Does it keep my facecam?`),
        a: t(
          msg`Yes. A webcam tile in your OBS scene is found automatically and the clip is stacked: gameplay on top, your camera below. You can force any section to another layout, or set a crop by hand.`,
        ),
      },
      {
        q: t(msg`Can I clip a whole server's streams?`),
        a: t(
          msg`With each streamer's permission, yes, and self-hosted there is no cap. Each person can have their own account on one install, with their own vocabulary and defaults, and the queue runs the VODs through and resumes after a restart.`,
        ),
      },
      {
        q: t(msg`Will GTA RP move to GTA 6?`),
        a: t(msg`That is up to the roleplay communities and their mod tools. Reelsaw does not care which game is on screen; it clips what is said over it.`),
      },
    ],
    sources: [README, LAYOUTS],
    disclaimer: t(msg`Reelsaw is not affiliated with Rockstar Games or Take-Two Interactive. Grand Theft Auto and GTA are their trademarks.`),
  },
  {
    slug: "twitch-clips-to-tiktok",
    nav: t(msg`Twitch to TikTok`),
    hint: t(msg`VODs to vertical clips`),
    updated: UPDATED,
    metaTitle: t(msg`Twitch to TikTok: AI clips from your stream VODs`),
    metaDescription: t(
      msg`Turn a Twitch VOD into vertical TikTok, Shorts and Reels clips with AI: paste the link, get your facecam stacked under the stream and word-level captions. Open source.`,
    ),
    h1: t(msg`Twitch to TikTok: turn a stream VOD into vertical clips`),
    intro: [
      t(
        msg`A Twitch clip is 16:9, at most a minute, and cut by whoever pressed the button. A TikTok is 9:16, captioned, and starts on its hook. Getting from one to the other by hand is an hour of scrubbing per stream.`,
      ),
      t(
        msg`Reelsaw does it from the VOD link: it transcribes the stream, picks the moments that work on their own, frames your facecam and the stream for a phone, and burns in captions word by word.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`From VOD link to clips`),
        bullets: [
          t(
            msg`Paste the Twitch VOD (or highlight) link. Reelsaw downloads it with yt-dlp; a subscriber-only VOD will not download from a link, so download it from your dashboard and upload the file.`,
          ),
          t(msg`Past broadcasts expire after a while on Twitch, so clip them or save them before they go.`),
          t(msg`Reelsaw transcribes the stream, chunks it at long pauses and ranks every standalone moment. Clips stream into the workspace as they render.`),
          t(msg`Trim, change the layout, edit the hook and caption style, then download each clip or a zip with a paste-ready caption per clip.`),
        ],
      },
      GAMEPLAY_FRAMING,
      {
        heading: t(msg`Just Chatting and IRL streams`),
        paragraphs: [
          t(
            msg`When you are the picture, the crop follows your face with smooth, tripod-like moves. With a guest on camera it follows whoever is talking, checked with an audio-visual model so a laugh or a sip is not mistaken for speech, and stacks both of you when it is not sure. Phone footage shown between bars is cropped to the picture itself.`,
          ),
        ],
      },
      {
        heading: t(msg`Captions people read with the sound off`),
        bullets: [
          t(msg`Word-level karaoke highlight, with the key words of each clip coloured and enlarged by the model (editable).`),
          t(msg`Boxed or outlined styles, any font your instance admin uploads, uppercase, one word at a time or two short lines.`),
          t(msg`Drag the captions and hook on a live 9:16 preview with the platform's safe zones shown, so nothing hides under the TikTok buttons.`),
          t(msg`Every script the transcription model takes, from Spanish and Portuguese to Japanese, Korean and Arabic.`),
        ],
      },
      {
        heading: t(msg`What it costs`),
        paragraphs: [COST_PARAGRAPH],
      },
    ],
    faqs: [
      NEEDS_SPEECH,
      {
        q: t(msg`Does Reelsaw use Twitch chat or clip counts to pick moments?`),
        a: t(
          msg`No. It picks from what was said, scored by a language model on hook, value, flow and shareability. A moment chat spammed but nobody talked about will not rank; a story you told while nobody clipped it will.`,
        ),
      },
      {
        q: t(msg`Can it clip every new VOD automatically?`),
        a: t(
          msg`Not on its own, but everything is an MCP tool with signed webhooks, so an n8n flow, a script or an AI agent can call create_project when a VOD appears and act on the clips when the webhook says they are done.`,
        ),
      },
      {
        q: t(msg`Does it post to TikTok for me?`),
        a: t(
          msg`No. The export zip has a TikTok post body, a YouTube Data API body and paste-ready text per clip, and share links a scheduler such as Buffer or Metricool can fetch.`,
        ),
      },
    ],
    sources: [README, LAYOUTS],
    disclaimer: t(msg`Reelsaw is not affiliated with Twitch or TikTok.`),
  },
  {
    slug: "kick-clips",
    nav: t(msg`Kick clips`),
    hint: t(msg`Kick streams to Shorts`),
    updated: UPDATED,
    metaTitle: t(msg`Kick clip generator: AI clips from Kick stream VODs`),
    metaDescription: t(
      msg`Clip Kick streams into vertical TikToks, Shorts and Reels with AI: facecam stacked under the stream, word-level captions, no per-clip credits. Open source and self-hostable.`,
    ),
    h1: t(msg`Kick clips: turn Kick stream VODs into vertical shorts`),
    intro: [
      t(
        msg`Kick streams run long and loud, and most of their reach comes from clips posted somewhere else. Reelsaw turns a Kick VOD into vertical clips the same way it handles Twitch and YouTube: transcribe, pick the moments that stand on their own, frame for a phone, caption word by word.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`Getting the VOD in`),
        bullets: [
          t(msg`Paste the Kick VOD link: Reelsaw downloads with yt-dlp, which has a Kick extractor.`),
          t(
            msg`If Kick refuses the download (it sometimes blocks automated requests), save the VOD and upload the file instead. Uploads take the same path from there.`,
          ),
          t(msg`Long streams are fine: the transcript is chunked at long pauses so the middle of the stream is read as carefully as its start.`),
        ],
      },
      GAMEPLAY_FRAMING,
      {
        heading: t(msg`IRL and Just Chatting streams`),
        paragraphs: [
          t(
            msg`When the stream is you on camera, the crop follows your face; with guests it follows whoever is talking and stacks two people when it is not sure. Each clip is split at scene cuts, so a clip that cuts from your camera to a screen share switches layout at the cut.`,
          ),
        ],
      },
      {
        heading: t(msg`What it costs`),
        paragraphs: [COST_PARAGRAPH],
      },
    ],
    faqs: [
      NEEDS_SPEECH,
      {
        q: t(msg`Can I clip a big Kick streamer for a clipping campaign?`),
        a: t(msg`If the campaign allows it, yes: that is the permission. See the clipping campaigns page for how Reelsaw fits that work.`),
      },
      {
        q: t(msg`Does it watermark the clips?`),
        a: t(msg`Self-hosted, never. On the hosted Free plan, yes; paid plans from $12 a month do not.`),
      },
    ],
    sources: [README, LAYOUTS, { href: "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md", label: t(msg`yt-dlp supported sites`) }],
    disclaimer: t(msg`Reelsaw is not affiliated with Kick.`),
  },
  {
    slug: "clipping-campaigns",
    nav: t(msg`Clipping campaigns`),
    hint: t(msg`paid per view`),
    updated: UPDATED,
    metaTitle: t(msg`AI clipping for paid clipping campaigns (Whop, Content Rewards)`),
    metaDescription: t(
      msg`Clipping campaigns pay per 1,000 views, so volume and speed decide what you earn. How an AI clipper with no per-clip credits fits Whop and Content Rewards campaigns.`,
    ),
    h1: t(msg`AI clipping for paid clipping campaigns`),
    intro: [
      t(
        msg`Clipping is now a job: streamers, podcasters and brands fund campaigns on marketplaces like Whop's Content Rewards, and clippers are paid per 1,000 views on the clips they post. GTA 6's launch week alone had several campaigns open around big streamers playing it.`,
      ),
      t(
        msg`Per-view pay rewards volume: many clips from many sources, posted fast. That is the job an AI clipper does well, and the one per-clip credit pricing punishes.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`How clipping campaigns work`),
        bullets: [
          t(
            msg`A creator or brand funds a campaign with a budget and a rate per 1,000 views, plus rules: which sources, which platforms, what the clip must show or link.`,
          ),
          t(msg`You make clips from the approved sources and post them on your own TikTok, YouTube Shorts, Instagram or X accounts.`),
          t(msg`You submit the posts; the marketplace reviews them and pays on verified views, usually after a minimum.`),
          t(msg`Marketplace figures put typical rates around $1 per 1,000 views in 2026. Rates vary widely by campaign; read each one.`),
        ],
      },
      {
        heading: t(msg`Where Reelsaw fits`),
        bullets: [
          t(
            msg`No per-clip credits: hosted plans meter minutes of source video, and self-hosted Reelsaw has no meter at all, so a 6-hour stream costs the same whether it yields 5 clips or 40.`,
          ),
          t(msg`Long sources read end to end: campaign streams run for hours, and the transcript is chunked so hour five is weighed like minute five.`),
          t(
            msg`Only the part you need: on a long stream, pick the ranges the campaign covers (or YouTube's Most replayed peaks) and only those minutes are downloaded and counted.`,
          ),
          t(msg`'Find clips about …' keeps only moments on the campaign's topic, and instructions steer the rest ('the reactions, not the gameplay menus').`),
          t(msg`Captions and hooks people stop for: word-level highlight, key words picked by the model, safe-zone overlay for each platform.`),
          t(msg`An export zip per stream with a paste-ready caption, a TikTok post body and a YouTube Data API body per clip.`),
          t(
            msg`Agents and scripts: every step is an MCP tool and a webhook, so you can queue a campaign's VODs, wait, and pull the clips without touching the app.`,
          ),
        ],
      },
      {
        heading: t(msg`What to check before you post`),
        bullets: [
          t(msg`The campaign's source list: clip only what the campaign covers. The footage belongs to the creator, and the campaign is your permission.`),
          t(msg`Watermarks: hosted Free clips carry a Reelsaw watermark, which campaigns may reject. Self-hosted and paid plans have none.`),
          t(msg`Each platform's rules on reposted content: add your own hook and edit so the clip is more than a re-upload.`),
        ],
      },
      {
        heading: t(msg`What it costs`),
        paragraphs: [COST_PARAGRAPH],
      },
    ],
    faqs: [
      NEEDS_SPEECH,
      {
        q: t(msg`How many clips can I make from one stream?`),
        a: t(
          msg`As many as the stream earns. There is no fixed count: weak picks are dropped relative to the rest of the stream, the best is always kept, and you can set an 'at most N' cap or make more clips by hand from any time range.`,
        ),
      },
      {
        q: t(msg`Is clipping someone else's stream allowed?`),
        a: t(msg`Inside a campaign that covers that creator, yes; that is what the campaign pays for. Outside one, ask the creator first.`),
      },
      {
        q: t(msg`Can Reelsaw post the clips and submit them to the campaign?`),
        a: t(msg`No. It makes and exports the clips with post text; posting and submitting stay with you, or with a scheduler or agent you set up.`),
      },
    ],
    sources: [
      { href: "https://docs.whop.com/manage-your-business/growth-marketing/content-rewards", label: t(msg`Whop docs: Content Rewards`) },
      {
        href: "https://www.cnbc.com/2026/11/20/gta-vi-launch-streaming-content-economy.html",
        label: t(msg`CNBC: GTA VI's launch and the content economy (20 Nov 2026)`),
      },
      README,
    ],
    disclaimer: t(msg`Reelsaw is not affiliated with Whop or Content Rewards.`),
  },
  {
    slug: "most-replayed-heatmap-clips",
    nav: t(msg`Most replayed clips`),
    hint: t(msg`heatmap-driven AI clipping`),
    updated: "2026-11-24",
    metaTitle: t(msg`Heatmap AI clipping: clip YouTube's Most replayed moments`),
    metaDescription: t(
      msg`Turn the peaks of YouTube's Most replayed heatmap into vertical clips with AI: only the hot minutes are downloaded, transcribed and counted. Open source, MCP and CLI.`,
    ),
    h1: t(msg`Heatmap-driven AI clipping: start from the moments viewers already replay`),
    intro: [
      t(
        msg`YouTube draws a Most replayed graph over the progress bar of most popular videos: a heatmap of the seconds viewers rewound to and watched again. On a three-hour stream or podcast, the peaks of that graph are the audience telling you where the clips are.`,
      ),
      t(
        msg`Reelsaw reads the heatmap before it downloads anything, turns its peaks into ranges, and clips only those: a language model snaps each one to whole sentences, the speaker is reframed to 9:16 and the captions are burned in word by word. You pay for the minutes of the peaks, not the whole video.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`How a heatmap becomes clips`),
        bullets: [
          t(
            msg`Paste a YouTube link. Reelsaw looks up the video's length and its Most replayed heatmap (yt-dlp reads it as 100 bins across the video) before any download.`,
          ),
          t(
            msg`The peaks are the bins hotter than the video's median and their neighbours, grown across the bins still at half their height or more, cut to at most two minutes and never under 10 seconds. Overlapping peaks keep the hotter one.`,
          ),
          t(
            msg`On the New project page the peaks are chips over the video's timeline, one click each, next to ranges you drag yourself. An agent passes rangesFrom.mostReplayed: 5 to create_project, and the CLI takes --most-replayed 5.`,
          ),
          t(
            msg`Only the peaks are downloaded (with 15 seconds of context each side, fetched but not counted), transcribed and analysed. Each peak becomes a clip whose ends are snapped to the nearest sentences, so it opens on words, not where the graph happens to rise. A peak longer than your longest clip setting is searched for its best moment instead.`,
          ),
          t(
            msg`The rest is the same pipeline as a whole video: a hook and title per clip, face-tracked or stacked framing, word-level captions, and an editor to trim on the word or widen a clip into the padding.`,
          ),
        ],
      },
      {
        heading: t(msg`What it saves on a long video`),
        paragraphs: [
          t(
            msg`The example on the home page is a 2 hour 29 minute stream. Its five hottest peaks came to 8.5 minutes: about 6% of the video downloaded, transcribed and counted against the plan, and five clips out the other end. On hosted Reelsaw that fits inside a Free month; the whole stream would have used half a Creator month.`,
          ),
          COST_PARAGRAPH,
        ],
      },
      {
        heading: t(msg`Heatmap peaks or AI picks?`),
        table: {
          columns: ["", t(msg`Most replayed peaks`), t(msg`AI picks across the whole video`)],
          rows: [
            [t(msg`What decides`), t(msg`Viewers' rewinds, then sentence bounds`), t(msg`A language model scores every standalone moment`)],
            [t(msg`What is downloaded and counted`), t(msg`Only the peaks`), t(msg`The whole video (or its start, on a plan's limit)`)],
            [t(msg`Works on`), t(msg`Public YouTube videos with enough views to have a heatmap`), t(msg`Any link or upload with speech`)],
            [
              t(msg`Best for`),
              t(msg`Old, popular long videos: back catalogues, other people's streams you clip with permission`),
              t(msg`New uploads, your own footage, videos with no heatmap`),
            ],
          ],
        },
        paragraphs: [
          t(
            msg`You can mix them in one project: peaks as exact clips, plus a range you drag yourself set to 'Find clips' so the model picks inside it. Ranges added later to a finished project fetch and count only the new time.`,
          ),
        ],
      },
      {
        heading: t(msg`From an agent or a pipeline`),
        bullets: [
          t(
            msg`check_source with a link and an empty ranges list returns the peaks (mostReplayed: start, end and heat) and what the ranges would cost, before anything is created.`,
          ),
          t(
            msg`create_project with rangesFrom.mostReplayed: 5 clips the five hottest; every clip carries its range id, and a ref you pass comes back on the clip and its webhooks.`,
          ),
          t(msg`extend_project with new ranges adds more peaks or ranges to the same project later, at the cost of the new minutes only.`),
          t(msg`On the command line: reelsaw create-project <url> --most-replayed 5.`),
        ],
      },
      {
        heading: t(msg`What it does not do`),
        bullets: [
          t(
            msg`It does not invent a heatmap: new or small videos, and most sites other than YouTube (Twitch and Kick VODs, uploads), have none. Asking for peaks there is refused with that reason; drag ranges or clip the whole video instead.`,
          ),
          t(msg`It does not read chat, comments or clip counts. The heatmap is a suggestion source; the clip bounds come from the transcript.`),
          t(msg`It does not clip a stream while it is live; a live or upcoming link is refused. Clip the recording once it is up.`),
        ],
      },
    ],
    faqs: [
      {
        q: t(msg`What is YouTube's Most replayed heatmap?`),
        a: t(
          msg`A graph YouTube shows above the progress bar of videos with enough views: how often each part of the video was replayed compared with the rest. Peaks mark the moments people went back for, which is a strong hint of what works on its own as a short.`,
        ),
      },
      {
        q: t(msg`Can I clip someone else's video from its heatmap?`),
        a: t(
          msg`Only with permission: your own channel, a channel you edit for, or a clipping campaign that covers it. The heatmap tells you where to look; the footage still belongs to its creator.`,
        ),
      },
      {
        q: t(msg`Do the peaks cost minutes if they overlap?`),
        a: t(
          msg`No. Overlapping ranges merge into one and are counted once, and ranges under a minute apart share one download but are billed separately for their own seconds only. The 15 seconds of context each side are never counted.`,
        ),
      },
      {
        q: t(msg`Does it work self-hosted?`),
        a: t(msg`Yes. The heatmap comes from yt-dlp on your own machine, and self-hosted Reelsaw has no minute meter, so peaks there only save time.`),
      },
    ],
    sources: [
      README,
      {
        href: "https://github.com/osbytes/reelsaw/blob/main/docs/specs/range-clipping.md",
        label: t(msg`Reelsaw range clipping spec (peaks, padding, billing)`),
      },
      { href: "https://github.com/yt-dlp/yt-dlp#readme", label: t(msg`yt-dlp README (the heatmap field)`) },
    ],
    disclaimer: t(msg`Reelsaw is not affiliated with YouTube or Google.`),
  },
  {
    slug: "webinar-to-clips",
    nav: t(msg`Webinar and Zoom clips`),
    hint: t(msg`slides and a webcam tile`),
    updated: "2026-11-24",
    metaTitle: t(msg`Webinar to clips: turn Zoom, Teams and Meet recordings into shorts`),
    metaDescription: t(
      msg`Turn webinar and Zoom, Teams or Meet recordings into vertical clips with AI: slides on top, the speaker's webcam tile below, names spelled right in the captions.`,
    ),
    h1: t(msg`Webinar to clips: Zoom, Teams and Meet recordings as vertical shorts`),
    intro: [
      t(
        msg`A webinar recording is the worst case for a face-tracking clipper: the speaker is a small webcam tile in a corner, the content is a slide deck, and a crop that follows the face throws the slides away.`,
      ),
      t(
        msg`Reelsaw finds the webcam tile and stacks the clip: the slides or screen share on top, the speaker below at their tile's own shape. It picks the moments worth posting from what was said, spells product and guest names right, and burns in word-level captions.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`Framing a recording with slides`),
        bullets: [
          t(
            msg`Webcam tile: a picture-in-picture box from Zoom, Teams, Meet or OBS is found as a steady rectangle around a face and placed under the content, enlarged, over a blurred copy of itself. A flat band beside the tile is dropped from the top pane so the slides fill it.`,
          ),
          t(msg`Speaker view: when the recording cuts to a full-frame camera, the crop follows the face, and switches layout at the cut.`),
          t(
            msg`Two people on camera: the crop follows whoever is talking, checked with an audio-visual model so a nod or a laugh is not taken for speech, and stacks both when it is not sure.`,
          ),
          t(
            msg`Slides only: the whole frame sits over a blurred copy of itself, so nothing on the slide is cropped. One clip's framing can be copied to the whole project with 'Use for all clips', since a webinar's layout rarely changes.`,
          ),
        ],
      },
      {
        heading: t(msg`From recording to clips`),
        bullets: [
          t(msg`Upload the MP4 from Zoom's cloud or local recording, Teams or Meet, or paste a link to the replay on YouTube, Vimeo or any site yt-dlp reads.`),
          t(
            msg`Add the product, company and guests' names to the vocabulary so transcription spells them right; every correction shows in the transcript to accept or reject.`,
          ),
          t(
            msg`Steer the picks: 'Find clips about pricing' keeps only that topic, and instructions such as 'the customer stories, not the agenda or Q&A housekeeping' do the rest.`,
          ),
          t(
            msg`Fillers, repetitions and false starts are cut for English, each cut placed by forced alignment and reviewable, and long pauses can be shortened.`,
          ),
          t(msg`Export a zip with each clip, a paste-ready LinkedIn or YouTube caption, and share links a scheduler can fetch.`),
        ],
      },
      {
        heading: t(msg`Shapes for where the clip goes`),
        paragraphs: [
          t(
            msg`Clips render 9:16 for Shorts, Reels and TikTok by default, or 4:5 and 1:1 for LinkedIn and feeds, or 16:9, per project or per clip. The stack of slides and speaker keeps its two panes in 4:5 and 1:1, so the slide stays readable.`,
          ),
        ],
      },
      {
        heading: t(msg`Private recordings stay private`),
        paragraphs: [
          t(
            msg`Internal all-hands, customer calls and pre-launch demos should not go to a vendor. Self-hosted Reelsaw runs fully local by default (Ollama for the language model, a local Whisper for transcription, face detection on the CPU), so the recording never leaves the machine. Hosted at app.reelsaw.com it runs the same code.`,
          ),
          COST_PARAGRAPH,
        ],
      },
    ],
    faqs: [
      {
        q: t(msg`Can Reelsaw clip a Zoom recording automatically?`),
        a: t(
          msg`It clips any recording it is given, and everything is an MCP tool and a signed webhook, so a script, n8n or Make flow or AI agent can start a project when a recording lands and post the clips when they finish. It does not connect to your Zoom account itself.`,
        ),
      },
      {
        q: t(msg`What if the slides have text burned in that looks like captions?`),
        a: t(
          msg`Reelsaw hides captions already burned into the source so they do not clash with its own, and leaves text that hugs the sides of the frame alone. If it hides a slide line, set the project's source text to keep (set_project_source_text, or reelsaw source-text) and the clips re-render.`,
        ),
      },
      {
        q: t(msg`Does it work for conference talks and keynotes?`),
        a: t(msg`Yes. A keynote with slides beside the speaker is one of the home page's demo runs: the whole frame on top, the speaker followed below.`),
      },
    ],
    sources: [README, LAYOUTS],
    disclaimer: t(msg`Reelsaw is not affiliated with Zoom, Microsoft or Google.`),
  },
  {
    slug: "clip-videos-with-claude",
    nav: t(msg`Clip with Claude (MCP)`),
    hint: t(msg`agents that make shorts`),
    updated: "2026-11-24",
    metaTitle: t(msg`Clip videos with Claude: an MCP server that makes shorts`),
    metaDescription: t(
      msg`Connect Reelsaw's MCP server to Claude, Cursor, n8n or any MCP client and turn long videos into captioned vertical clips from a chat. Free plan included, or self-host.`,
    ),
    h1: t(msg`Clip videos with Claude and other AI agents over MCP`),
    intro: [
      t(
        msg`An AI agent can write the post, plan the calendar and call your tools, but it cannot watch a two-hour video and cut a 30-second short from it. That step needs transcription, moment ranking, face-tracked reframing and a video render.`,
      ),
      t(
        msg`Reelsaw is that step as an MCP server. Add it to Claude (claude.ai, Claude Desktop or Claude Code), Cursor or any MCP client, and the agent can create a project from a link, wait for it, read the clips, change them and hand you download links, with the same tools the app's own screens use.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`Connect it`),
        bullets: [
          t(
            msg`claude.ai or Claude Desktop: add a custom connector with the address https://app.reelsaw.com/api/mcp (or your own install's). You sign in and approve it in the browser; no key to paste.`,
          ),
          t(msg`Claude Code: claude mcp add --transport http reelsaw https://app.reelsaw.com/api/mcp, then /mcp to sign in.`),
          t(
            msg`Scripts, n8n, Make and clients that cannot sign in: create an API key under Settings, API keys and MCP, and send it as a Bearer token. A tool call is one HTTP POST.`,
          ),
          t(msg`On your own machine, reelsaw mcp speaks stdio as well.`),
        ],
      },
      {
        heading: t(msg`What an agent can do`),
        bullets: [
          t(
            msg`check_source prices a link before anything runs, and lists its Most replayed peaks; create_project starts it, wait_for_project waits for the clips.`,
          ),
          t(msg`get_project, get_clip and get_transcript read the clips, their scores and reasons, and the timed words.`),
          t(
            msg`update_clip changes a clip's text, bounds, framing, captions and layers; update_project_style restyles every clip; create_clip makes one from any time range; reanalyze_project picks again.`,
          ),
          t(
            msg`list_transcript_flags and review_transcript_flags accept or reject name fixes and filler cuts; add_transcript_correction fixes a word the captions got wrong.`,
          ),
          t(msg`export_project and get_media_links return share links, so an agent in a sandbox can download the clips without holding your session.`),
          t(msg`create_webhook subscribes a URL to project.done and clip.done, signed with Standard Webhooks, so a pipeline acts the moment clips are ready.`),
        ],
      },
      {
        heading: t(msg`A prompt that works`),
        paragraphs: [
          t(
            msg`'Clip the five Most replayed peaks of <link>, keep the captions boxed and yellow, and give me the download links with a TikTok caption for each.' The agent calls check_source, create_project with rangesFrom, wait_for_project, update_project_style and export_project in turn, and tells you what each step did.`,
          ),
        ],
      },
      {
        heading: t(msg`Why it is built for agents`),
        bullets: [
          t(msg`Every feature on a screen ships with its MCP tool, backed by the same service code, so the agent is never a second-class user.`),
          t(msg`Destructive tools are reversible for a while: deleted projects and clips can be restored, and risky changes ask first in the app.`),
          t(msg`On every plan, hosted Free included, and on every self-hosted install: no API tier to buy.`),
          t(msg`Bring your own models: the language, transcription and alignment models are each any provider, or fully local with Ollama and Whisper.`),
        ],
      },
      {
        heading: t(msg`What it costs`),
        paragraphs: [COST_PARAGRAPH],
      },
    ],
    faqs: [
      {
        q: t(msg`Does Claude need code execution to download the clips?`),
        a: t(
          msg`No. The tools return share links you can open in a browser. If you ask Claude to fetch the files in its own sandbox and the download answers 403, allow the Reelsaw host in Claude's domain allowlist for code execution.`,
        ),
      },
      {
        q: t(msg`Which MCP protocol versions does it speak?`),
        a: t(msg`The 2026-07-28 protocol and every 2025 revision, over Streamable HTTP, so newer and older clients both connect.`),
      },
      {
        q: t(msg`Can an agent post the clips for me?`),
        a: t(
          msg`Reelsaw does not hold social accounts. The export has a TikTok post body and a YouTube Data API body per clip and share links Buffer or Metricool can fetch, so an agent with those tools, or an n8n or Make flow, can post them.`,
        ),
      },
    ],
    sources: [
      { href: "https://github.com/osbytes/reelsaw#mcp-drive-reelsaw-from-an-agent", label: t(msg`Reelsaw README: MCP server and tools`) },
      { href: "https://modelcontextprotocol.io", label: t(msg`Model Context Protocol`) },
      README,
    ],
    disclaimer: t(msg`Reelsaw is not affiliated with Anthropic. Claude is a trademark of Anthropic.`),
  },
];

export const useCaseBySlug = (slug: string) => USE_CASES.find((u) => u.slug === slug);
