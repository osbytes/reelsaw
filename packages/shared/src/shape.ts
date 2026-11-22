/**
 * Output shapes: the frame a clip is rendered into (style `shape`). 9:16 is the default and what every automatic
 * framing decision is made for; 4:5 and 1:1 (Instagram and LinkedIn feeds) and 16:9 (YouTube, a website) reuse the
 * same decision with the frame's own size (docs/LAYOUTS.md, "Output shapes").
 */
import { z } from "zod";

export const OUTPUT_SHAPES = ["9:16", "4:5", "1:1", "16:9"] as const;
export const outputShapeSchema = z
  .enum(OUTPUT_SHAPES)
  .describe("Shape of the rendered video: 9:16 (default; TikTok, Shorts, Reels), 4:5 or 1:1 (feeds), 16:9 (YouTube, websites)");
export type OutputShape = z.infer<typeof outputShapeSchema>;

/** Rendered size per shape: the short side is always 1080 px, so text sized in those pixels reads the same on every shape. */
export const OUTPUT_SIZE: Record<OutputShape, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "4:5": { w: 1080, h: 1350 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};
export const SHAPE_LABEL: Record<OutputShape, string> = { "9:16": "Vertical 9:16", "4:5": "Portrait 4:5", "1:1": "Square 1:1", "16:9": "Landscape 16:9" };

export function outputSize(shape: OutputShape | undefined | null): { w: number; h: number } {
  return OUTPUT_SIZE[shape ?? "9:16"] ?? OUTPUT_SIZE["9:16"];
}

/** Pixels of a 1080-wide 9:16 frame to pixels of this frame: text and outlines sized for 9:16 keep their look. */
export function frameScale(width: number, height: number): number {
  return Math.min(width, height) / 1080;
}

/** The largest window of the source with the frame's shape, full height (or full width when the source is narrower). */
export function frameCrop(srcW: number, srcH: number, aspect: number): { w: number; h: number } {
  return { w: Math.min(srcW, srcH * aspect), h: Math.min(srcH, srcW / aspect) };
}

/**
 * The layout a piece is drawn with in this shape. Two stacked panes need a frame taller than it is wide; in 16:9 a
 * split or a stack shows the whole frame instead (for a 16:9 source, exactly the source). Every other layout keeps
 * its meaning: the face crop is a window of the frame's shape, `fit` is the whole frame over a blur.
 */
export function layoutForShape<L extends string>(layout: L, shape: OutputShape | undefined | null): L | "fit" {
  return (shape ?? "9:16") === "16:9" && (layout === "split" || layout === "stack") ? "fit" : layout;
}
