import { CAPTION_FONT_FRAC, HOOK_FONT_FRAC, lineSecondsFor, captionMaxChars, lineDisplayEnd, monotonicWords, emphasisKey, type Word, type Style } from "@reelsaw/shared";

export interface CaptionOptions {
  /** burned-in text for accounts whose plan or instance asks for it (quota.ts `watermarkFor`); bottom centre, above the platform UI zone */
  watermark?: string;
  /** the logo is composited above the text (render.ts `watermarkLogo`): the text goes smaller and sits right under it */
  watermarkUnderLogo?: boolean;
  width: number;
  height: number;
  font: string;
  style: Style;
  /** Hook text; omitted or style.showHook=false → no hook. */
  hook?: string;
  /** Key words to colour (matched case/punctuation-insensitively). */
  emphasis?: string[];
  maxLineSeconds?: number;
  /** text overlays (clip overlays of kind "text"), in the body's own seconds; drawn above the captions */
  texts?: TextOverlayEvent[];
}

/** One text overlay as the ASS file draws it: centre position and size as fractions of the frame. */
export interface TextOverlayEvent {
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  /** font size as a fraction of the frame height */
  size: number;
  /** #RRGGBB */
  color: string;
  /** dark plate behind the text instead of an outline */
  box: boolean;
  opacity: number;
}

/**
 * Where the logo watermark sits (fractions of the 9:16 frame): top-left, just under the platform's
 * top band (TikTok, Shorts and Reels all keep that corner clear; the bottom fifth is their username
 * and description, the right edge their buttons). The text line sits tight under the logo. Shared
 * by the compositor (render.ts) and the caption file.
 */
export const WATERMARK_LOGO = {
  /** centre of the logo */
  x: 0.15,
  y: 0.095,
  /** width as a fraction of the frame width; the file is 900x240 */
  w: 0.18,
  aspect: 900 / 240,
  opacity: 0.95,
  /** text size as a fraction of the frame height */
  textSize: 0.017,
  /** gap between the logo's bottom edge and the text, fraction of the frame height */
  gap: 0.004,
} as const;
/** Centre y of the text line under the logo (logo height = w × 9/16 ÷ aspect of the frame height). */
export const watermarkTextY = () => WATERMARK_LOGO.y + (WATERMARK_LOGO.w * (9 / 16)) / WATERMARK_LOGO.aspect / 2 + WATERMARK_LOGO.gap + WATERMARK_LOGO.textSize / 2;

/** "#RRGGBB" → ASS "&HBBGGRR&" */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "&H00D7FF&";
  return `&H${m[3]}${m[2]}${m[1]}&`.toUpperCase();
}

function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
}

function esc(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\r?\n/g, "\\N");
}

export { groupCaptionLines as groupLines } from "@reelsaw/shared";
import { groupCaptionLines as groupLines } from "@reelsaw/shared";

/** Caption font size in output pixels for a frame of the given height (mirrors the web preview). */
export function captionFontPx(height: number, size: number) {
  return Math.round(CAPTION_FONT_FRAC * height * size);
}
export function hookFontPx(height: number) {
  return Math.round(HOOK_FONT_FRAC * height);
}

/**
 * Build an ASS subtitle file. `words` must already be relative to the clip start.
 * Text blocks are centred on (captionX, captionY) / (hookX, hookY) of the frame via \an5\pos.
 */
export function buildAss(input: Word[], opts: CaptionOptions): string {
  const words = monotonicWords(input);
  const { width, height, font, style } = opts;
  const scale = height / 1920;
  const captionSize = captionFontPx(height, style.captionSize);
  const hookSize = hookFontPx(height);
  const outline = Math.max(2, Math.round(4 * scale));
  const margin = Math.round(width * 0.06);
  const pos = (x: number, y: number) => `{\\an5\\pos(${Math.round(x * width)},${Math.round(y * height)})}`;
  const capPos = pos(style.captionX, style.captionY);
  const hookPos = pos(style.hookX, style.hookY);
  const hi = assColor(style.highlightColor);
  const tx = (t: string) => esc(style.uppercase ? t.toUpperCase() : t);
  // "box" = opaque box behind the line (BorderStyle 3), the look most clip tools default to
  const captionStyle =
    style.captions === "box"
      ? `Style: Caption,${font},${captionSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,${Math.round(12 * scale)},0,5,${margin},${margin},0,1`
      : `Style: Caption,${font},${captionSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},1,5,${margin},${margin},0,1`;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${captionStyle}
Style: Hook,${font},${hookSize},&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,${Math.round(14 * scale)},0,5,${margin},${margin},0,1
Style: Watermark,${font},${Math.round(height * 0.024)},&H50FFFFFF,&H50FFFFFF,&H70000000,&H70000000,-1,0,0,0,100,100,${Math.round(1.5 * scale)},0,1,${Math.max(1, Math.round(1.5 * scale))},0,5,${margin},${margin},0,1
Style: Text,${font},${captionSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},1,5,${margin},${margin},0,1
Style: TextBox,${font},${captionSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,${Math.round(12 * scale)},0,5,${margin},${margin},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  const clipEnd = words.length ? words[words.length - 1]!.end : 0;

  // text overlays: above the captions (layer 1), below the watermark; size, colour and alpha per event
  for (const t of opts.texts ?? []) {
    if (t.end - t.start < 0.05) continue;
    const alpha = Math.round((1 - Math.max(0.1, Math.min(1, t.opacity))) * 255);
    const a = alpha ? `\\alpha&H${alpha.toString(16).toUpperCase().padStart(2, "0")}&` : "";
    const fs = Math.max(8, Math.round(t.size * height));
    events.push(`Dialogue: 1,${assTime(t.start)},${assTime(t.end)},${t.box ? "TextBox" : "Text"},,0,0,0,,${pos(t.x, t.y)}{\\fs${fs}\\c${assColor(t.color)}${a}}${esc(t.text)}`);
  }

  // the whole clip, on its own layer; libass renders it from the ASS file, so no extra ffmpeg filter is needed
  if (opts.watermark) {
    // under the logo: a bit smaller, just below the logo's bottom edge (WATERMARK_LOGO in render.ts)
    const place = opts.watermarkUnderLogo ? `${pos(WATERMARK_LOGO.x, watermarkTextY())}{\\fs${Math.round(height * WATERMARK_LOGO.textSize)}}` : pos(0.5, 0.91);
    events.push(`Dialogue: 2,${assTime(0)},${assTime(Math.max(clipEnd, 1) + 3600)},Watermark,,0,0,0,,${place}${esc(opts.watermark)}`);
  }

  if (style.showHook && opts.hook && style.hookSeconds > 0) {
    const end = Math.min(style.hookSeconds, Math.max(clipEnd, style.hookSeconds));
    events.push(`Dialogue: 1,${assTime(0)},${assTime(end)},Hook,,0,0,0,,${hookPos}${esc(opts.hook.toUpperCase())}`);
  }

  if (style.captions !== "none" && words.length) {
    const lines = groupLines(words, style.wordsPerLine, opts.maxLineSeconds ?? lineSecondsFor(style.wordsPerLine), captionMaxChars(style.captionSize));
    const em = style.emphasis ? new Set((opts.emphasis ?? []).map(emphasisKey).filter(Boolean)) : new Set<string>();
    const emColor = assColor(style.emphasisColor);
    const isEm = (w: Word) => em.has(emphasisKey(w.text));
    // emphasised (not active) word: own colour, slightly larger
    const plainWord = (w: Word) => (isEm(w) ? `{\\c${emColor}\\fscx112\\fscy112}${tx(w.text)}{\\c&HFFFFFF&\\fscx100\\fscy100}` : tx(w.text));
    lines.forEach((line, li) => {
      const start = line[0]!.start;
      const end = lineDisplayEnd(lines, li);
      if (style.captions === "plain" || style.captions === "box") {
        events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${capPos}${line.map(plainWord).join(" ")}`);
        return;
      }
      // karaoke: one event per word, the active word highlighted and slightly bigger
      for (let i = 0; i < line.length; i++) {
        const w = line[i]!;
        const wStart = i === 0 ? start : w.start;
        const wEnd = i === line.length - 1 ? end : line[i + 1]!.start;
        if (wEnd <= wStart) continue;
        const text = line.map((x, j) => (j === i ? `{\\c${hi}\\fscx112\\fscy112}${tx(x.text)}{\\c&HFFFFFF&\\fscx100\\fscy100}` : plainWord(x))).join(" ");
        events.push(`Dialogue: 0,${assTime(wStart)},${assTime(wEnd)},Caption,,0,0,0,,${capPos}${text}`);
      }
    });
  }

  return header + events.join("\n") + "\n";
}
