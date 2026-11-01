"use strict";

/**
 * A get_project result trimmed to what a Zap maps: the transcript, settings and bumpers stay in Reelsaw (they are large
 * and nested, and get_project / the app are where they are read).
 */
function projectOutput(p) {
  const clips = (p.clips || []).map((c) => ({
    id: c.id,
    index: c.index,
    title: c.title,
    hook: c.hook ?? null,
    score: c.score ?? null,
    startSec: c.startSec,
    endSec: c.endSec,
    durationSec: c.durationSec,
    status: c.status,
    error: c.error ?? null,
    layout: c.layout ?? null,
    url: p.url ? `${p.url}/clips/${c.id}` : null,
    videoUrl: c.videoUrl ?? null,
    thumbnailUrl: c.thumbnailUrl ?? null,
  }));
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    stage: p.stage ?? null,
    error: p.error ?? null,
    url: p.url ?? null,
    sourceUrl: p.sourceUrl ?? null,
    durationSec: p.durationSec ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt ?? null,
    metadata: p.metadata || {},
    clipCount: clips.length,
    renderedClipCount: clips.filter((c) => c.status === "done").length,
    exportZipUrl: p.exportZipUrl ?? null,
    clips,
  };
}

const projectOutputFields = [
  { key: "id", label: "Project ID" },
  { key: "title", label: "Title" },
  { key: "status", label: "Status" },
  { key: "stage", label: "Stage" },
  { key: "error", label: "Error" },
  { key: "url", label: "Project URL" },
  { key: "sourceUrl", label: "Source Video URL" },
  { key: "durationSec", label: "Source Duration (s)", type: "number" },
  { key: "createdAt", label: "Created At", type: "datetime" },
  { key: "clipCount", label: "Clip Count", type: "integer" },
  { key: "renderedClipCount", label: "Rendered Clip Count", type: "integer" },
  { key: "exportZipUrl", label: "Export Zip URL (needs API key)" },
  { key: "clips[]id", label: "Clip ID" },
  { key: "clips[]title", label: "Clip Title" },
  { key: "clips[]status", label: "Clip Status" },
];

module.exports = { projectOutput, projectOutputFields };
