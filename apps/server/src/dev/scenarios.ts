/**
 * Scenarios: projects in a known state, made in seconds without a download, a model or the pipeline, for
 * screenshots, UI review and manual checks of states that are slow or awkward to reach for real (a Free account's
 * 240p preview, its used manual-clip allowance, a source that vanished, a failed link).
 *
 *   docker compose exec app reelsaw scenario list
 *   docker compose exec app reelsaw scenario <name> --user <email> [--plan free|starter|creator|pro] [--source <video>]
 *
 * Rows are written the way the pipeline would leave them (project, transcript, clips with rendered files, the events
 * the activity log reads), with media made by ffmpeg: a test pattern, or `--source` cut and scaled to the scenario's
 * height. `--plan` sets the account's plan the way a Stripe sync would (a paid plan = an active subscription row;
 * free = none). Runs only when APP_URL is a local address: it fakes billing state and must never touch a real instance.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { defaultProjectSettings, type ProjectStatus } from "@reelsaw/shared";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import type { Services } from "../services.js";
import { ENCODE_PASS_CPU } from "../resources.js";

export interface ScenarioOptions {
  userEmail: string;
  plan?: string | undefined;
  /** a local video to cut the source from; default: an ffmpeg test pattern with a tone */
  sourceFile?: string | undefined;
}

interface Spec {
  about: string;
  status: ProjectStatus;
  /** stored source height; `preview` marks it as a plan's preview copy (clips render from windows) */
  height: number;
  preview: boolean;
  durationSec: number;
  /** [start, end] of the clips Reelsaw "found", rendered and done */
  clips: Array<[number, number]>;
  /** also add a clip made by hand (uses the Free allowance of one) */
  manualClip?: boolean;
  /** the full-quality window could not be had, so the first clip rendered from the preview */
  sourceGone?: boolean;
  error?: string;
}

const CLIPS: Array<[number, number]> = [
  [62, 101],
  [94, 131],
  [300, 338],
];

/**
 * Only states that stay put: finished or failed. A working state (downloading, rendering) has no job behind it, so
 * the reconciler resumes it and it moves on (a fake link then fails to download) before a screenshot is taken.
 */
export const SCENARIOS: Record<string, Spec> = {
  "preview-done": {
    about: "Free account's link: a 240p preview source, three clips rendered from full-quality windows",
    status: "done",
    height: 240,
    preview: true,
    durationSec: 420,
    clips: CLIPS,
  },
  "preview-manual-used": {
    about: "preview-done plus one clip made by hand: the next create_clip is refused with the upgrade action",
    status: "done",
    height: 240,
    preview: true,
    durationSec: 420,
    clips: CLIPS,
    manualClip: true,
  },
  "preview-source-gone": {
    about: "preview-done where the video was removed before one clip's window was fetched: that clip rendered from the preview",
    status: "done",
    height: 240,
    preview: true,
    durationSec: 420,
    clips: CLIPS,
    sourceGone: true,
  },
  "full-done": {
    about: "a paid (or admin) account's link: the full-quality source, three clips",
    status: "done",
    height: 720,
    preview: false,
    durationSec: 420,
    clips: CLIPS,
  },
  failed: {
    about: "a link whose download failed for good",
    status: "failed",
    height: 240,
    preview: true,
    durationSec: 420,
    clips: [],
    error: "Could not download: the video is private.",
  },
};

/** What the seeded transcript says, on repeat: a few sentences of sample speech, not a vocabulary. */
const SCRIPT = [
  "so the thing nobody tells you about shipping",
  "is that the last ten percent takes as long as the first ninety",
  "and that is fine because the last ten percent",
  "is where the product actually becomes something people want to use every single day",
];
const WORDS = SCRIPT.join(" ").split(" ");

/** Refuses anywhere but a local instance: it writes fake billing state and fake projects. */
export function assertLocal(appUrl: string): void {
  const host = new URL(appUrl).hostname;
  if (!(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".test")))
    throw new Error(`scenarios run only on a local instance (APP_URL is ${appUrl})`);
}

export async function seedScenario(svc: Services, name: string, o: ScenarioOptions): Promise<{ projectId: string; url: string; clips: number }> {
  assertLocal(svc.config.APP_URL);
  const spec = SCENARIOS[name];
  if (!spec) throw new Error(`unknown scenario "${name}"; one of: ${Object.keys(SCENARIOS).join(", ")}`);
  const db = svc.database.db;
  const user = await db.query.user.findFirst({ where: eq(schema.user.email, o.userEmail.toLowerCase()) });
  if (!user) throw new Error(`no account ${o.userEmail}: sign up first (the scenario fills an existing account)`);
  if (o.plan) await setPlan(svc, user.id, o.plan);

  const projectId = randomUUID();
  const work = path.join(svc.config.DATA_DIR, "tmp", `scenario-${projectId}`);
  await fs.mkdir(work, { recursive: true });
  try {
    const hasMedia = spec.status === "done";
    let source: { key: string; bytes: number; width: number; height: number } | null = null;
    if (hasMedia) source = await makeSource(svc, projectId, work, spec, o.sourceFile);

    const words = fakeWords(spec.durationSec);
    const clipRows = hasMedia ? await makeClips(svc, projectId, work, spec, source!) : [];
    await svc.tx(async (u) => {
      await u.db.insert(schema.projects).values({
        id: projectId,
        userId: user.id,
        title: `Scenario: ${name}`,
        sourceType: "url",
        sourceUrl: "https://www.youtube.com/watch?v=scenario000",
        sourceKey: source?.key ?? null,
        sourceBytes: source?.bytes ?? null,
        sourceMeta: {
          title: `Scenario: ${name}`,
          uploader: "Reelsaw scenarios",
          duration: spec.durationSec,
          ...(spec.preview ? { previewHeight: spec.height } : {}),
        },
        durationSec: spec.durationSec,
        width: source?.width ?? null,
        height: source?.height ?? null,
        status: spec.status,
        error: spec.error ?? null,
        // the failed scenario is a private link: a source problem, as ingest would record it
        failureCause: spec.status === "failed" ? "input" : null,
        settings: defaultProjectSettings,
        runSeq: 1,
        runReason: "created",
        runStartedAt: new Date(),
      });
      await u.emit("project.created", { projectId, title: `Scenario: ${name}`, sourceType: "url" });
      await u.emit("run.started", { projectId, seq: 1, reason: "created" });
      if (hasMedia) {
        await u.db.insert(schema.transcripts).values({
          projectId,
          language: "en",
          text: words.map((w) => w.text).join(" "),
          words,
          segments: segmentsOf(words),
        });
        for (const c of clipRows) await u.db.insert(schema.clips).values(c);
        if (spec.preview) {
          // what the windows would have recorded: one merged window over the first two clips, one for the third
          const windows: Array<[number, number, number, boolean]> = [
            [59, 134, 2, false],
            [297, 341, 1, false],
          ];
          for (const [start, end, clips, stitched] of windows) {
            if (spec.sourceGone && start > 200) continue;
            await u.emit("source.section_fetched", {
              projectId,
              clipId: clipRows.find((c) => c.startSec >= start)!.id,
              start,
              end,
              bytes: Math.round((end - start) * 1.1e6),
              height: 1080,
              aligned: "audio",
              downloadedSec: end - start,
              clips,
              stitched,
            });
          }
          if (spec.sourceGone)
            await u.emit("clip.preview_source", {
              projectId,
              clipId: clipRows[clipRows.length - 1]!.id,
              height: spec.height,
              reason: "Video unavailable. This video is private.",
            });
        }
        await u.emit("project.done", { projectId, runSeq: 1, runReason: "created", clips: clipRows.length, failed: 0 });
      }
      if (spec.status === "failed")
        await u.emit("project.failed", {
          projectId,
          runSeq: 1,
          runReason: "created",
          stage: "ingest",
          error: spec.error ?? "failed",
          errorKind: "source_unavailable",
        });
    });
    return { projectId, url: new URL(`/p/${projectId}`, svc.config.APP_URL).toString(), clips: clipRows.length };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** The account's plan as a Stripe sync would leave it: paid = an active subscription row, free = none. */
async function setPlan(svc: Services, userId: string, plan: string): Promise<void> {
  // plans are the enterprise edition's: loaded only when it runs (docs/specs/ee.md), never from open code at import time
  if (!svc.ee) throw new Error("--plan needs the billing module (REELSAW_EE=true)");
  const { PLANS } = await import("../ee/billing/plans.js");
  if (!PLANS.some((p) => p.name === plan)) throw new Error(`unknown plan "${plan}"; one of: ${PLANS.map((p) => p.name).join(", ")}`);
  const db = svc.database.db;
  await db.delete(schema.billingSubscriptions).where(eq(schema.billingSubscriptions.userId, userId));
  if (plan === "free") return;
  const now = new Date();
  await db.insert(schema.billingSubscriptions).values({
    userId,
    plan,
    status: "active",
    interval: "month",
    periodStart: now,
    periodEnd: new Date(now.getTime() + 30 * 86_400_000),
  } as typeof schema.billingSubscriptions.$inferInsert);
}

async function makeSource(
  svc: Services,
  projectId: string,
  work: string,
  spec: Spec,
  sourceFile: string | undefined,
): Promise<{ key: string; bytes: number; width: number; height: number }> {
  const file = path.join(work, "source.mp4");
  const h = spec.height;
  const w = Math.round((h * 16) / 9 / 2) * 2;
  const input = sourceFile
    ? ["-i", sourceFile, "-t", String(spec.durationSec)]
    : ["-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", String(spec.durationSec)];
  const encode = (threads: number) =>
    svc.media.ffmpeg(
      [
        "-y",
        ...input,
        "-vf",
        `scale=-2:${h}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        file,
      ],
      { threads },
    );
  await svc.resources.withCpu({ kind: "scenario-encode", cpu: ENCODE_PASS_CPU }, encode);
  const probe = await svc.media.ffprobe(file);
  const key = keys.source(projectId, ".mp4");
  await svc.storage.putFile(key, file);
  return { key, bytes: (await fs.stat(file)).size, width: probe.width ?? w, height: probe.height ?? h };
}

async function makeClips(
  svc: Services,
  projectId: string,
  work: string,
  spec: Spec,
  source: { key: string },
): Promise<Array<typeof schema.clips.$inferInsert & { id: string; startSec: number }>> {
  const local = await svc.storage.ensureLocal(source.key, path.join(work, "source-local.mp4"));
  const ranges: Array<[number, number, "ai" | "manual"]> = [...spec.clips.map(([a, b]): [number, number, "ai"] => [a, b, "ai"])];
  if (spec.manualClip) ranges.push([180, 214, "manual"]);
  const titles = ["The last ten percent", "Why shipping takes as long as it does", "What people use every day", "My own pick"];
  const out: Array<typeof schema.clips.$inferInsert & { id: string; startSec: number }> = [];
  for (const [i, [start, end, origin]] of ranges.entries()) {
    const id = randomUUID();
    const mp4 = path.join(work, `${id}.mp4`);
    const jpg = path.join(work, `${id}.jpg`);
    await svc.resources.withCpu({ kind: "scenario-encode", cpu: ENCODE_PASS_CPU }, (threads) =>
      svc.media.ffmpeg(
        [
          "-y",
          "-ss",
          String(start),
          "-t",
          String(end - start),
          "-i",
          local,
          "-vf",
          "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "30",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          mp4,
        ],
        { threads },
      ),
    );
    await svc.media.ffmpeg(["-y", "-ss", "1", "-i", mp4, "-frames:v", "1", "-vf", "scale=360:-2", jpg], { threads: "light" });
    const outputKey = keys.clip(projectId, id, 0);
    const thumbnailKey = keys.thumb(projectId, id, 0);
    await svc.storage.putFile(outputKey, mp4);
    await svc.storage.putFile(thumbnailKey, jpg);
    out.push({
      id,
      projectId,
      index: i,
      title: titles[i] ?? `Clip ${i + 1}`,
      hook: "Nobody tells you this about shipping",
      startSec: start,
      endSec: end,
      score: origin === "manual" ? 0 : 90 - i * 7,
      reasoning: "Scenario clip.",
      hashtags: ["shipping", "startups"],
      status: "done",
      origin,
      outputKey,
      thumbnailKey,
    });
  }
  return out;
}

function fakeWords(durationSec: number): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let t = 0.5;
  let i = 0;
  while (t < durationSec - 1) {
    const text = WORDS[i % WORDS.length]!;
    const len = 0.18 + text.length * 0.035;
    out.push({ text, start: Number(t.toFixed(2)), end: Number((t + len).toFixed(2)) });
    t += len + (i % 17 === 16 ? 0.6 : 0.08);
    i++;
  }
  return out;
}

function segmentsOf(words: Array<{ text: string; start: number; end: number }>) {
  const segs: Array<{ text: string; start: number; end: number }> = [];
  for (let i = 0; i < words.length; i += 12) {
    const chunk = words.slice(i, i + 12);
    segs.push({ text: chunk.map((w) => w.text).join(" "), start: chunk[0]!.start, end: chunk.at(-1)!.end });
  }
  return segs;
}
