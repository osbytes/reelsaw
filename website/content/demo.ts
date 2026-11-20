/**
 * The real runs the home page shows: Creative Commons BY videos put through hosted Reelsaw with default settings,
 * and the clips it made, in its own order, with its own reasons. Nothing here is edited or re-picked by hand.
 * Swapping in a newer run is a data change here plus the files in public/clips/:
 * - `<file>.mp4` / `.jpg`: the first 8 s of the rendered clip (540×960) and a poster frame;
 * - `<file>-before.mp4` / `.jpg`: the same seconds of the 16:9 source (720×406), uncut.
 * website/README.md ("The demo clips") has the ffmpeg lines.
 */

export type DemoSource = {
  /** What the video is, in a few words ("podcast", "webinar"). */
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

export type DemoReframe = {
  /** The layout as the editor names it, and a plain-words title for it. */
  layout: "Face" | "Stack";
  title: string;
  /** The detector's own reason, from the clip's layout segments. */
  reason: string;
  file: string;
  source: DemoSource;
  /** Where the crop centres on the source over the excerpt: [seconds into the excerpt, x as a fraction of the width]. */
  track?: [number, number][];
  /** Height of the face the crop follows, as a fraction of the source height. */
  y?: number;
};

const PODCAST: DemoSource = {
  kind: "podcast",
  title: "We Started a Podcast with Zero Experience. Here's What 1 Year Taught Us",
  author: "Truth and Time Podcast",
  url: "https://www.youtube.com/watch?v=8-VaZrVcHXY",
  length: "15:27",
  seconds: 927,
};

const TWO_SHOT: DemoSource = {
  kind: "podcast",
  title: "When is it Time to Quit?",
  author: "Stand Show",
  url: "https://www.youtube.com/watch?v=6vA17_NU9ts",
  length: "11:30",
  seconds: 690,
};

const WEBINAR: DemoSource = {
  kind: "webinar",
  title: "Webinar: Building for Builders",
  author: "Product School",
  url: "https://www.youtube.com/watch?v=6k1cHhGyH78",
  length: "12:58",
  seconds: 778,
};

/** Hosted Reelsaw, default settings, 20 November 2026: the podcast came out as 8 clips. */
export const DEMO_RUN = {
  source: PODCAST,
  clips: 8,
  picks: [
    {
      rank: 1,
      hook: "How we launched a podcast!",
      why: "Captures the excitement of starting a podcast and the connection between the two hosts.",
      file: "pick-1",
      start: 47.85,
      end: 71.09,
    },
    {
      rank: 2,
      hook: "We're actually living it!",
      why: "Puts experience over theory, with a strong takeaway for viewers.",
      file: "pick-2",
      start: 829.42,
      end: 849.49,
    },
    {
      rank: 4,
      hook: "Where will we be in a year?",
      why: "Invites viewers to picture what comes next, which builds anticipation.",
      file: "pick-4",
      start: 875.94,
      end: 900.18,
    },
    {
      rank: 8,
      hook: "Podcasting isn't as easy as it seems!",
      why: "Shows how much there is to it, for viewers who think podcasting is simple.",
      file: "pick-8",
      start: 331.13,
      end: 388.5,
    },
  ] satisfies DemoPick[],
};

/** The order the hero plays them in (#1 opens on the source's own lower-third title, so it is not first). */
export const HERO_ORDER = [2, 4, 8, 1];

export const REFRAMES: DemoReframe[] = [
  {
    layout: "Face",
    title: "Two people, one wide shot",
    reason: "active speaker right, then left at 0:09",
    file: "speaker",
    source: TWO_SHOT,
    track: [
      [0, 0.708],
      [8.9, 0.708],
      [8.9, 0.208],
      [12, 0.208],
    ],
    y: 0.36,
  },
  {
    layout: "Face",
    title: "A camera on each speaker",
    reason: "face in 100% of frames, 29% tall",
    file: "pick-1",
    source: PODCAST,
  },
  {
    layout: "Stack",
    title: "Slides with a webcam tile",
    reason: "face too small (13% of frame height)",
    file: "stack",
    source: WEBINAR,
  },
];

/** The clip the Captions tab plays. */
export const CAPTIONS_FILE = "pick-8";

/** Every source besides the main run's, for the credit line. */
export const OTHER_SOURCES: DemoSource[] = [TWO_SHOT, WEBINAR];

export const clipVideo = (file: string) => `/clips/${file}.mp4`;
export const clipPoster = (file: string) => `/clips/${file}.jpg`;

/** 254.3 → "4:14" */
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
