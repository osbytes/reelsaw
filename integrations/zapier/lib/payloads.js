"use strict";

/**
 * Turning Reelsaw webhook bodies (docs/specs/webhooks.md, "Envelope"; built by apps/server/src/webhooks/payload.ts)
 * into Zapier trigger items, and building the same shape from get_project for the Zap editor's samples.
 *
 * An item is the envelope with `data` lifted to the top level: { id, type, createdAt, apiVersion, project, clips | clip,
 * …, metadata }. Zapier flattens nested objects itself ("Project Title", "Clip Share Url"), and keeps `clips` as line
 * items, so nothing is renamed and a field means the same here as in the webhook docs.
 */

/** The envelope as one trigger item. */
function itemFromBody(body) {
  const data = body.data || {};
  const item = {
    id: body.id,
    type: body.type,
    createdAt: body.createdAt,
    apiVersion: body.apiVersion,
    ...data,
    metadata: body.metadata || {},
  };
  if (Array.isArray(data.clips)) {
    item.clipCount = data.clips.length;
    item.renderedClipCount = data.clips.filter((c) => c && c.status === "done").length;
  }
  return item;
}

/** The project summary every webhook carries, from a get_project result. */
function projectSummary(p) {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    url: p.url,
    sourceUrl: p.sourceUrl ?? null,
    durationSec: p.durationSec ?? null,
    createdAt: p.createdAt,
  };
}

/**
 * A webhook-shaped clip from get_project's clip summary. get_project does not carry caption, hashtags, renderGen or
 * share links, and samples do not mint share links (a sample load should not create public links to the user's
 * videos), so those are null here and filled on real deliveries.
 */
function clipFromProject(p, c) {
  return {
    id: c.id,
    index: c.index,
    title: c.title,
    hook: c.hook ?? null,
    caption: null,
    hashtags: null,
    score: c.score ?? null,
    startSec: c.startSec,
    endSec: c.endSec,
    durationSec: c.durationSec,
    layout: c.layout ?? null,
    status: c.status,
    renderGen: null,
    url: p.url ? `${p.url}/clips/${c.id}` : null,
    videoUrl: c.videoUrl ?? null,
    thumbnailUrl: c.thumbnailUrl ?? null,
    shareUrl: null,
    thumbnailShareUrl: null,
  };
}

const sampleEnvelope = (type, p, data) => ({
  id: `sample_${type}_${data.clip ? data.clip.id : p.id}`,
  type,
  createdAt: p.updatedAt || p.createdAt,
  apiVersion: 1,
  data,
  metadata: p.metadata || {},
});

function sampleProjectDone(p) {
  const clips = (p.clips || []).map((c) => clipFromProject(p, c));
  const anyRendered = clips.some((c) => c.status === "done");
  return itemFromBody(
    sampleEnvelope("project.done", p, {
      project: projectSummary(p),
      run: { seq: null, reason: null, runSec: null },
      clips,
      exportUrl: anyRendered ? p.exportZipUrl || null : null,
      exportShareUrl: null,
    }),
  );
}

function sampleProjectFailed(p) {
  return itemFromBody(
    sampleEnvelope("project.failed", p, {
      project: projectSummary(p),
      run: { seq: null, reason: null, runSec: null },
      stage: p.stage ?? null,
      error: p.error ?? null,
    }),
  );
}

function sampleClipDone(p, c) {
  return itemFromBody(sampleEnvelope("clip.done", p, { project: projectSummary(p), clip: clipFromProject(p, c) }));
}

// ---- static samples (shown before the user has any data; same shape as a real delivery) ----

const SAMPLE_PROJECT = {
  id: "3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47",
  title: "Episode 42: Shipping on Fridays",
  status: "done",
  url: "https://app.reelsaw.com/p/3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47",
  sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  durationSec: 3725.4,
  createdAt: "2026-10-31T14:20:03.512Z",
};

const SAMPLE_CLIP = {
  id: "a91c4e02-58b3-4d7f-8e26-0b7d3f1c9a65",
  index: 0,
  title: "Why we stopped deploying on Fridays",
  hook: "We lost a whole weekend to one deploy.",
  caption: "The one rule our team never breaks.",
  hashtags: ["#devops", "#startups"],
  score: 81,
  startSec: 612.3,
  endSec: 644.8,
  durationSec: 32.5,
  layout: "face",
  status: "done",
  renderGen: 1,
  url: "https://app.reelsaw.com/p/3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47/clips/a91c4e02-58b3-4d7f-8e26-0b7d3f1c9a65",
  videoUrl: "https://app.reelsaw.com/media/clips/3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47/a91c4e02-58b3-4d7f-8e26-0b7d3f1c9a65.mp4",
  thumbnailUrl: "https://app.reelsaw.com/media/clips/3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47/a91c4e02-58b3-4d7f-8e26-0b7d3f1c9a65.jpg",
  shareUrl: "https://app.reelsaw.com/m/k3q9x2Lw8VbT/why-we-stopped-deploying-on-fridays.mp4",
  thumbnailShareUrl: "https://app.reelsaw.com/m/h7p2c0Rn4XsQ/why-we-stopped-deploying-on-fridays.jpg",
};

const SAMPLE_METADATA = { runId: "zap-episode-pipeline" };

const SAMPLE_BODIES = {
  "project.done": {
    id: "evt_8812",
    type: "project.done",
    createdAt: "2026-10-31T15:02:11.204Z",
    apiVersion: 1,
    data: {
      project: SAMPLE_PROJECT,
      run: { seq: 1, reason: "created", runSec: 2471 },
      clips: [SAMPLE_CLIP],
      exportUrl: "https://app.reelsaw.com/api/projects/3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47/export.zip",
      exportShareUrl: "https://app.reelsaw.com/m/a9b1c2Md6YeU/episode-42-shipping-on-fridays.zip",
    },
    metadata: SAMPLE_METADATA,
  },
  "clip.done": {
    id: "evt_8807",
    type: "clip.done",
    createdAt: "2026-10-31T15:01:40.031Z",
    apiVersion: 1,
    data: { project: { ...SAMPLE_PROJECT, status: "rendering" }, clip: SAMPLE_CLIP },
    metadata: SAMPLE_METADATA,
  },
  "project.failed": {
    id: "evt_8790",
    type: "project.failed",
    createdAt: "2026-10-31T14:21:12.880Z",
    apiVersion: 1,
    data: {
      project: { ...SAMPLE_PROJECT, status: "failed", durationSec: null },
      run: { seq: 1, reason: "created", runSec: 68 },
      stage: "ingest",
      error: "The video could not be downloaded: it is private or needs a sign-in.",
    },
    metadata: SAMPLE_METADATA,
  },
};

const sampleItem = (type) => itemFromBody(SAMPLE_BODIES[type]);

module.exports = {
  itemFromBody,
  projectSummary,
  clipFromProject,
  sampleProjectDone,
  sampleProjectFailed,
  sampleClipDone,
  sampleItem,
  SAMPLE_BODIES,
};
