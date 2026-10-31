"use strict";

const { callTool, normalizeBaseUrl } = require("../lib/mcp");

/** Only keys with a value: Zapier sends "" for fields left empty in some cases, and dict rows can be half-filled. */
function cleanMetadata(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    if (key && v !== undefined && v !== null) out[key] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

const perform = async (z, bundle) => {
  const { sourceUrl, title, metadata, maxClips, focus } = bundle.inputData;
  const settings = {};
  if (maxClips !== undefined && maxClips !== null && maxClips !== "") settings.maxClips = Number(maxClips);
  if (focus && String(focus).trim()) settings.focus = String(focus).trim();
  const args = { sourceUrl: String(sourceUrl).trim() };
  if (title && String(title).trim()) args.title = String(title).trim();
  const meta = cleanMetadata(metadata);
  if (meta) args.metadata = meta;
  if (Object.keys(settings).length) args.settings = settings;

  const p = await callTool(z, bundle, "create_project", args);
  return {
    id: p.id,
    title: p.title ?? null,
    status: p.status,
    url: `${normalizeBaseUrl(bundle.authData.baseUrl)}/p/${p.id}`,
    sourceUrl: p.sourceUrl ?? args.sourceUrl,
    metadata: p.metadata || {},
    createdAt: p.createdAt ?? null,
  };
};

module.exports = {
  key: "create_project",
  noun: "Project",
  display: {
    label: "Create Project",
    description:
      "Starts clipping a video from a URL (YouTube, Vimeo, a direct MP4 link, anything yt-dlp fetches). Use the Project Finished trigger to act on the clips.",
  },
  operation: {
    inputFields: [
      {
        key: "sourceUrl",
        label: "Video URL",
        required: true,
        helpText: "An http(s) link to the video, for example a YouTube watch URL.",
      },
      {
        key: "title",
        label: "Title",
        required: false,
        helpText: "Project title (up to 200 characters). Leave empty to use the video's own title.",
      },
      {
        key: "metadata",
        label: "Metadata",
        dict: true,
        required: false,
        helpText:
          "Your own key/value pairs (up to 20 keys; keys are letters, digits, `_`, `.` or `-`; 1 KB in all). Every Reelsaw trigger for this project carries them back, so a later Zap can tell which run it belongs to.",
      },
      {
        key: "maxClips",
        label: "Max Clips",
        type: "integer",
        required: false,
        helpText: "The most clips to pick (1-50). Leave empty to let Reelsaw keep every moment that stands on its own.",
      },
      {
        key: "focus",
        label: "Focus",
        type: "text",
        required: false,
        helpText: 'Only pick clips about this topic, for example "pricing" (up to 300 characters). Leave empty for the best moments.',
      },
    ],
    perform,
    sample: {
      id: "3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47",
      title: "Episode 42: Shipping on Fridays",
      status: "queued",
      url: "https://app.reelsaw.com/p/3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47",
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      metadata: { runId: "zap-episode-pipeline" },
      createdAt: "2026-10-31T14:20:03.512Z",
    },
    outputFields: [
      { key: "id", label: "Project ID" },
      { key: "title", label: "Title" },
      { key: "status", label: "Status" },
      { key: "url", label: "Project URL" },
      { key: "sourceUrl", label: "Video URL" },
      { key: "createdAt", label: "Created At", type: "datetime" },
    ],
  },
};
