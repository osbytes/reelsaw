/**
 * The real runs the home page shows: Creative Commons BY videos put through hosted Reelsaw with default settings,
 * and the clips it made, in its own order, with its own reasons. Nothing here is edited or re-picked by hand.
 * The sources are chosen to show the range of framing: a game with a facecam, a podcast shot wide and close, and a
 * keynote with slides beside the speaker. Swapping in a newer run is a data change here plus the files in
 * public/clips/:
 * - `<file>.mp4` / `.jpg`: the first seconds of the rendered clip (540×960) and a poster frame;
 * - `<file>-before.mp4` / `.jpg`: the same seconds of the 16:9 source (720×406), uncut.
 * website/README.md ("The demo clips") has the ffmpeg lines.
 *
 * The hooks (burned into the clips), the model's reasons and the detector's reasons and regions are the run's own
 * output (get_project / get_clip over MCP) and stay as it wrote them; the page's own words around them are in the
 * catalogue.
 */
import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";

export type DemoSource = {
  /** What the video is, in a few words ("podcast", "keynote"). */
  kind: string;
  title: string;
  author: string;
  url: string;
  /** Length as shown on the video ("15:27") and in seconds. */
  length: string;
  seconds: number;
};

export type DemoPick = {
  /** Rank among the run's clips (1 = the model's top pick). */
  rank: number;
  /** The hook the model wrote, burned into the clip's first seconds. */
  hook: string;
  /** The model's one-line reason for the pick. */
  why: string;
  /** public/clips/<file>.mp4 (+ -before.mp4) */
  file: string;
  /** Where in the source the clip starts and ends, seconds. */
  start: number;
  end: number;
};

/** A rectangle on the source, as fractions of its width and height: [x1, y1, x2, y2]. */
type Box = [number, number, number, number];

export type DemoReframe = {
  /** The layout as the editor names it, and a plain-words title for it. */
  layout: "Face" | "Split" | "Stack";
  title: string;
  /** What the detector reported for the excerpt, from the clip's layout segments. */
  reason: string;
  file: string;
  source: DemoSource;
  /** Where the crop centres on the source over the excerpt: [seconds into the excerpt, x as a fraction of the width]. */
  track?: [number, number][];
  /** Where the marker sits, as a fraction of the source height: just above the face the crop follows. */
  y?: number;
  /** The label on the tracked point ("speaking" when omitted). */
  marker?: string;
  /** Regions the detector found (a webcam tile, the screen content), drawn over the source. */
  regions?: { label: string; box: Box }[];
};

const GAME: DemoSource = {
  kind: t(msg`let's play`),
  title: "This Horror Game uses your Webcam To Kill You..",
  author: "GCMX",
  url: "https://www.youtube.com/watch?v=h59lPw3yHcI",
  length: "18:07",
  seconds: 1087,
};

const PODCAST: DemoSource = {
  kind: t(msg`podcast`),
  title: "Dead Money Changes The Game COMPLETELY // T1k Poker Podcast Ep 54",
  author: "T1k Podcast",
  url: "https://www.youtube.com/watch?v=SoyzEH5Vwt0",
  length: "37:32",
  seconds: 2252,
};

const KEYNOTE: DemoSource = {
  kind: t(msg`keynote`),
  title: "Keynote — Blender Conference 2025",
  author: "Blender",
  url: "https://www.youtube.com/watch?v=JXm0-ilIknE",
  length: "25:08",
  seconds: 1508,
};

const STREAM: DemoSource = {
  kind: t(msg`stream`),
  title: "I Streamed Until I Beat Minecraft Hardcore...",
  author: "ohnepixel",
  url: "https://www.youtube.com/watch?v=cCR3hvs5t1o",
  length: "2:29:16",
  seconds: 8956,
};

const GAME_PICK: DemoPick = {
  rank: 4,
  hook: "I'm flipping scared!",
  why: "The fear of being unable to escape adds a layer of tension that resonates with horror fans.",
  file: "game",
  start: 731.15,
  end: 753.94,
};

const KEYNOTE_PICK: DemoPick = {
  rank: 4,
  hook: "Never liked having a boss!",
  why: "The speaker expresses a strong sentiment against traditional employment, resonating with many who value independence.",
  file: "talk",
  start: 860.37,
  end: 891.94,
};

/** Hosted Reelsaw, default settings, 23 November 2026: the podcast came out as 17 clips. */
export const DEMO_RUN = {
  source: PODCAST,
  clips: 17,
  picks: [
    {
      rank: 4,
      hook: "Is Vegas for the average gambler?",
      why: "This clip raises questions about the current gambling experience, engaging viewers with relatable content.",
      file: "podcast-4",
      start: 1869.27,
      end: 1898.93,
    },
    {
      rank: 5,
      hook: "Only for the ultra-rich now!",
      why: "The discussion about the exclusivity of Vegas experiences for high rollers highlights a significant shift in the gambling culture, which can resonate with many viewers.",
      file: "podcast-5",
      start: 1917.91,
      end: 1974.91,
    },
    {
      rank: 6,
      hook: "It's all about the math!",
      why: "This clip breaks down the mathematical approach to betting, making it insightful and educational.",
      file: "podcast-6",
      start: 1007.15,
      end: 1027.63,
    },
    {
      rank: 11,
      hook: "A $7K loss that could've been worse!",
      why: "This clip reveals a significant loss and the potential for an even bigger one, capturing the emotional stakes of the game.",
      file: "podcast-11",
      start: 1500.74,
      end: 1535.35,
    },
  ] satisfies DemoPick[],
};

const podcastPick = (rank: number) => DEMO_RUN.picks.find((p) => p.rank === rank)!;

/** What the hero plays, in order: one pick from each kind of video, and what its framing did. */
export const HERO: { source: DemoSource; clips: number; pick: DemoPick; framing: string }[] = [
  { source: PODCAST, clips: DEMO_RUN.clips, pick: podcastPick(6), framing: t(msg`follows whoever speaks`) },
  { source: GAME, clips: 8, pick: GAME_PICK, framing: t(msg`game on top, facecam below`) },
  { source: KEYNOTE, clips: 8, pick: KEYNOTE_PICK, framing: t(msg`slides on top, speaker below`) },
];

export const REFRAMES: DemoReframe[] = [
  {
    layout: "Face",
    title: t(msg`Two hosts, one wide shot`),
    reason: "active speaker left, then right at 0:13 (model, confidence 0.96)",
    file: "podcast-6",
    source: PODCAST,
    track: [
      [0, 0.251],
      [2, 0.279],
      [3, 0.263],
      [4, 0.232],
      [5, 0.242],
      [6, 0.249],
      [9, 0.259],
      [10, 0.251],
      [13.6, 0.696],
      [15, 0.708],
    ],
    y: 0.12,
  },
  {
    layout: "Stack",
    title: t(msg`Gameplay with a facecam`),
    reason: "small webcam in a corner over screen content; webcam tile top-right (x 0.72-1.00, y 0.00-0.40)",
    file: "game",
    source: GAME,
    regions: [
      { label: t(msg`game → top`), box: [0, 0, 0.716, 1] },
      { label: t(msg`facecam → bottom`), box: [0.716, 0, 1, 0.4] },
    ],
  },
  {
    layout: "Stack",
    title: t(msg`Speaker beside the slides`),
    reason: "face in 100% of frames, 7% tall: whole frame on top, the speaker followed below",
    file: "talk",
    source: KEYNOTE,
    track: [
      [0, 0.125],
      [1, 0.114],
      [2, 0.123],
      [3, 0.13],
      [4, 0.09],
      [5, 0.095],
      [7, 0.101],
      [8, 0.105],
      [9, 0.116],
    ],
    y: 0.12,
    marker: t(msg`following`),
  },
  {
    layout: "Split",
    title: t(msg`A camera each, then both`),
    reason: "two faces in 92% of frames, then face in 100% of frames, 27% tall at 0:03",
    file: "podcast-11",
    source: PODCAST,
  },
];

/** The clip the Captions tab plays. */
export const CAPTIONS_FILE = "podcast-4";

/**
 * The Most replayed section: a long stream, YouTube's replay heatmap for it (100 bins across the whole video, as
 * yt-dlp reads it), and the five hottest stretches Reelsaw's check_source returned for it, which create_project
 * planned as ranges and priced at `billedSec` (hosted Reelsaw, 23 November 2026).
 */
export const REPLAY = {
  source: STREAM,
  heat: [
    0.23, 0.16, 0.2, 0.05, 0.1, 0.13, 0.01, 0.12, 0.12, 0.26, 0.16, 0.02, 0.23, 0.24, 0.24, 0.03, 0.12, 0.03, 0.03, 0.17, 0.27, 0.11, 0.0, 0.14, 0.13, 0.12,
    0.09, 0.03, 0.19, 0.16, 1.0, 0.94, 0.44, 0.21, 0.11, 0.25, 0.11, 0.69, 0.19, 0.2, 0.66, 0.23, 0.09, 0.0, 0.02, 0.16, 0.06, 0.07, 0.14, 0.68, 0.18, 0.17,
    0.33, 0.16, 0.23, 0.42, 0.31, 0.36, 0.19, 0.08, 0.13, 0.08, 0.07, 0.05, 0.08, 0.24, 0.19, 0.06, 0.16, 0.24, 0.14, 0.14, 0.03, 0.04, 0.12, 0.21, 0.05, 0.03,
    0.06, 0.14, 0.1, 0.06, 0.03, 0.06, 0.22, 0.07, 0.06, 0.03, 0.09, 0.1, 0.13, 0.28, 0.18, 0.05, 0.14, 0.1, 0.24, 0.26, 0.18, 0.04,
  ],
  peaks: [
    { rank: 1, start: 2687, end: 2807 },
    { rank: 2, start: 3314, end: 3403 },
    { rank: 3, start: 4388, end: 4478 },
    { rank: 4, start: 3582, end: 3672 },
    { rank: 5, start: 4911, end: 5031 },
  ],
  billedSec: 509,
};

/** The app screenshots in the Moments, Fixes and Editor tabs (public/workspace.png and friends) show these. */
const SCREENSHOT_SOURCES: DemoSource[] = [
  {
    kind: t(msg`podcast`),
    title: "We Started a Podcast with Zero Experience. Here's What 1 Year Taught Us",
    author: "Truth and Time Podcast",
    url: "https://www.youtube.com/watch?v=8-VaZrVcHXY",
    length: "15:27",
    seconds: 927,
  },
  {
    kind: t(msg`webinar`),
    title: "Webinar: Building for Builders",
    author: "Product School",
    url: "https://www.youtube.com/watch?v=6k1cHhGyH78",
    length: "12:58",
    seconds: 778,
  },
];

/** The sources of the hero and the See it tabs besides the main run's, for their credit line. */
export const OTHER_SOURCES: DemoSource[] = [GAME, KEYNOTE, ...SCREENSHOT_SOURCES];

export const clipVideo = (file: string) => `/clips/${file}.mp4`;
export const clipPoster = (file: string) => `/clips/${file}.jpg`;

/** 254.3 → "4:14" */
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
