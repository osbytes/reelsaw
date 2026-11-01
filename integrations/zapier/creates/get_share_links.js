"use strict";

const { callTool } = require("../lib/mcp");

const KINDS = { clip: "Video (MP4)", thumb: "Thumbnail (JPEG)", srt: "Captions (SRT)", vtt: "Captions (WebVTT)" };

const perform = async (z, bundle) => {
  const projectId = String(bundle.inputData.projectId || "").trim();
  const clipId = String(bundle.inputData.clipId || "").trim();
  const asked = [].concat(bundle.inputData.kinds || []).filter((k) => k in KINDS);
  const kinds = asked.length ? [...new Set(asked)] : ["clip"];
  const args = { projectId, clipIds: [clipId], kinds };
  if (bundle.inputData.ttlDays) args.ttlDays = Number(bundle.inputData.ttlDays);

  const r = await callTool(z, bundle, "get_media_links", args);
  const c = (r.clips || []).find((x) => x.clipId === clipId);
  if (!c) throw new z.errors.Error(`Clip ${clipId} is not a rendered clip of project ${projectId}.`, "NOT_FOUND");
  // "Not rendered (rendering); wait for it, then ask again." — Reelsaw's own sentence
  if (c.notReady) throw new z.errors.Error(c.notReady, "NOT_READY");

  const out = { id: clipId, clipId, projectId, title: c.title ?? null };
  for (const kind of Object.keys(KINDS)) {
    const l = c.links && c.links[kind];
    out[`${kind}Url`] = l ? l.url : null;
    out[`${kind}ExpiresAt`] = l ? l.expiresAt : null;
    out[`${kind}LinkId`] = l ? l.linkId : null;
  }
  return out;
};

module.exports = {
  key: "get_share_links",
  noun: "Share Link",
  display: {
    label: "Get Share Links",
    description:
      "Gets links to a rendered clip that anyone can download without signing in, for Instagram, Buffer, Metricool or a file field in another step.",
  },
  operation: {
    inputFields: [
      {
        key: "projectId",
        label: "Project",
        required: true,
        dynamic: "project_list.id.title",
        altersDynamicFields: true,
        helpText: "The clip's project: pick one, or map Project ID from a Reelsaw trigger.",
      },
      {
        key: "clipId",
        label: "Clip",
        required: true,
        dynamic: "clip_list.id.title",
        helpText: "A rendered clip of that project: pick one, or map Clip ID from a Reelsaw trigger or Find Project.",
      },
      {
        key: "kinds",
        label: "Files",
        list: true,
        required: false,
        choices: KINDS,
        default: "clip",
        helpText: "Which files to link. Defaults to the video.",
      },
      {
        key: "ttlDays",
        label: "Days the Links Last",
        type: "integer",
        required: false,
        helpText:
          "Leave empty to reuse the clip's current link (90 days by default). A number makes a separate link with that lifetime, capped by your instance.",
      },
    ],
    perform,
    sample: {
      id: "a91c4e02-58b3-4d7f-8e26-0b7d3f1c9a65",
      clipId: "a91c4e02-58b3-4d7f-8e26-0b7d3f1c9a65",
      projectId: "3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47",
      title: "Why we stopped deploying on Fridays",
      clipUrl: "https://app.reelsaw.com/m/k3q9x2Lw8VbT/why-we-stopped-deploying-on-fridays.mp4",
      clipExpiresAt: "2027-01-29T15:02:11.204Z",
      clipLinkId: "lnk_3kq9x2",
      thumbUrl: null,
      thumbExpiresAt: null,
      thumbLinkId: null,
      srtUrl: null,
      srtExpiresAt: null,
      srtLinkId: null,
      vttUrl: null,
      vttExpiresAt: null,
      vttLinkId: null,
    },
    outputFields: [
      { key: "clipId", label: "Clip ID" },
      { key: "projectId", label: "Project ID" },
      { key: "title", label: "Clip Title" },
      { key: "clipUrl", label: "Video Share Link (MP4)" },
      { key: "clipExpiresAt", label: "Video Link Expires At", type: "datetime" },
      { key: "thumbUrl", label: "Thumbnail Share Link (JPEG)" },
      { key: "srtUrl", label: "Captions Share Link (SRT)" },
      { key: "vttUrl", label: "Captions Share Link (WebVTT)" },
    ],
  },
};
