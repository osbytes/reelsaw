/**
 * The body of a webhook delivery (docs/specs/webhooks.md, "Envelope"): built once, at the first attempt, from the event
 * row and the project and clips as they are then, and stored on the delivery so retries resend the same bytes. Clips
 * carry share links (media-links/service.ts, source "webhook") so a scheduler or Instagram can fetch them as they are.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { schema } from "../db/index.js";
import type { Clip, Project, WebhookDeliveryRow } from "../db/schema.js";
import { getOrCreateLink } from "../media-links/service.js";
import type { Services } from "../services.js";
import { webhookEventId } from "./service.js";

export const WEBHOOK_API_VERSION = 1;
/** a body larger than this is cut to the project summary (clips and text fields keep their caps, so this is a backstop) */
export const MAX_BODY_BYTES = 256 * 1024;

const abs = (svc: Services, p: string) => new URL(p, svc.config.APP_URL).toString();

/** A share link, or null when the clip has nothing to share yet (not rendered, no thumbnail). */
async function shareUrl(svc: Services, userId: string, target: Parameters<typeof getOrCreateLink>[2]): Promise<string | null> {
  try {
    return (await getOrCreateLink(svc, userId, target, { source: "webhook" })).url;
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "CONFLICT" || err.code === "NOT_FOUND")) return null;
    throw err;
  }
}

function projectSummary(svc: Services, p: Project) {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    url: abs(svc, `/p/${p.id}`),
    sourceUrl: p.sourceUrl,
    durationSec: p.durationSec,
    createdAt: p.createdAt.toISOString(),
    ...(p.deletedAt ? { deleted: true } : {}),
  };
}

async function clipPayload(svc: Services, userId: string, c: Clip) {
  const rendered = c.status === "done" && !!c.outputKey;
  return {
    id: c.id,
    index: c.index,
    title: c.title,
    hook: c.hook,
    caption: c.caption,
    hashtags: c.hashtags,
    score: c.score,
    startSec: c.startSec,
    endSec: c.endSec,
    durationSec: Math.round((c.endSec - c.startSec) * 100) / 100,
    layout: c.layout,
    status: c.status,
    renderGen: c.renderGen,
    url: abs(svc, `/p/${c.projectId}/clips/${c.id}`),
    /** needs the account's API key, like every /media URL */
    videoUrl: c.outputKey ? abs(svc, `/media/clips/${c.projectId}/${c.id}.mp4`) : null,
    thumbnailUrl: c.thumbnailKey ? abs(svc, `/media/clips/${c.projectId}/${c.id}.jpg`) : null,
    /** no header needed (share links) */
    shareUrl: rendered ? await shareUrl(svc, userId, { kind: "clip", clipId: c.id }) : null,
    thumbnailShareUrl: rendered && c.thumbnailKey ? await shareUrl(svc, userId, { kind: "thumb", clipId: c.id }) : null,
  };
}

/** One clip after another: each takes a share link under the account's lock, so fanning out would only queue on it. */
async function clipsPayload(svc: Services, userId: string, clips: Clip[]) {
  const out = [];
  for (const c of clips) out.push(await clipPayload(svc, userId, c));
  return out;
}

const runOf = (payload: Record<string, unknown>) => ({
  seq: typeof payload.runSeq === "number" ? payload.runSeq : null,
  reason: typeof payload.runReason === "string" ? payload.runReason : null,
  runSec: typeof payload.runSec === "number" ? payload.runSec : null,
});

/** The JSON body for a delivery, as the string that is signed and sent. */
export async function buildBody(svc: Services, d: WebhookDeliveryRow): Promise<string> {
  const db = svc.database.db;
  const id = webhookEventId(d);
  if (d.type === "webhook.test" || d.eventId === null || !d.projectId) {
    return JSON.stringify({
      id,
      type: "webhook.test",
      createdAt: d.createdAt.toISOString(),
      apiVersion: WEBHOOK_API_VERSION,
      data: { message: "This is a test delivery from Reelsaw. Real events look like this, with data about the project or clip." },
      metadata: {},
    });
  }
  const [event, project] = await Promise.all([
    db.query.projectEvents.findFirst({ where: eq(schema.projectEvents.id, d.eventId) }),
    db.query.projects.findFirst({ where: eq(schema.projects.id, d.projectId) }),
  ]);
  const payload = event?.payload ?? {};
  const createdAt = (event?.createdAt ?? d.createdAt).toISOString();
  const envelope = (data: Record<string, unknown>) => ({
    id,
    type: d.type,
    createdAt,
    apiVersion: WEBHOOK_API_VERSION,
    data,
    metadata: project?.metadata ?? {},
  });
  // the project was purged before the first attempt: say what the event said rather than drop it
  if (!project) return JSON.stringify(envelope({ project: { id: d.projectId, deleted: true }, event: payload }));
  const summary = projectSummary(svc, project);
  let data: Record<string, unknown>;
  switch (d.type) {
    case "project.done": {
      const clips = await db.query.clips.findMany({
        where: and(eq(schema.clips.projectId, project.id), isNull(schema.clips.deletedAt)),
        orderBy: asc(schema.clips.index),
        limit: 50,
      });
      const done = clips.filter((c) => c.status === "done" && c.outputKey);
      data = {
        project: summary,
        run: runOf(payload),
        clips: await clipsPayload(svc, project.userId, clips),
        exportUrl: done.length ? abs(svc, `/api/projects/${project.id}/export.zip`) : null,
        exportShareUrl: done.length && !project.deletedAt ? await shareUrl(svc, project.userId, { kind: "export", projectId: project.id }) : null,
      };
      break;
    }
    case "project.failed":
      data = { project: summary, run: runOf(payload), stage: payload.stage ?? null, error: payload.error ?? null };
      break;
    case "clip.done":
    case "clip.failed": {
      const clipId = typeof payload.clipId === "string" ? payload.clipId : null;
      const clip = clipId ? await db.query.clips.findFirst({ where: eq(schema.clips.id, clipId) }) : undefined;
      data = {
        project: summary,
        clip: clip && !clip.deletedAt ? await clipPayload(svc, project.userId, clip) : { id: clipId, deleted: true },
        ...(d.type === "clip.failed" ? { error: payload.error ?? null } : {}),
      };
      break;
    }
    default:
      data = { project: summary };
  }
  const body = JSON.stringify(envelope(data));
  return Buffer.byteLength(body) <= MAX_BODY_BYTES ? body : JSON.stringify(envelope({ project: summary, truncated: true }));
}
