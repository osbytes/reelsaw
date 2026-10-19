import { CAPTION_FONT_FRAC, HOOK_FONT_FRAC, lineSecondsFor, captionMaxChars, lineDisplayEnd, monotonicWords, emphasisKey, type Word, type Style } from "@reelsaw/shared";

export interface CaptionOptions {
  /** burned-in text for accounts whose plan or instance asks for it (quota.ts `watermarkFor`); bottom centre, above the platform UI zone */
  watermark?: string;
  width: number;
  height: number;
  font: string;
  style: Style;
  /** Hook text; omitted or style.showHook=false → no hook. */
  hook?: string;
  /** Key words to colour (matched case/punctuation-insensitively). */
  emphasis?: string[];
  maxLineSeconds?: number;
}

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

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  const clipEnd = words.length ? words[words.length - 1]!.end : 0;

  // the whole clip, on its own layer; libass renders it from the ASS file, so no extra ffmpeg filter is needed
  if (opts.watermark) events.push(`Dialogue: 2,${assTime(0)},${assTime(Math.max(clipEnd, 1) + 3600)},Watermark,,0,0,0,,${pos(0.5, 0.91)}${esc(opts.watermark)}`);

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
