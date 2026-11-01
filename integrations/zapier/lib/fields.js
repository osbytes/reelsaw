"use strict";

/** Labels for the fields people map most; Zapier still offers every other field of the item. */

const project = [
  { key: "id", label: "Event ID" },
  { key: "type", label: "Event Type" },
  { key: "createdAt", label: "Event Time", type: "datetime" },
  { key: "project__id", label: "Project ID" },
  { key: "project__title", label: "Project Title" },
  { key: "project__status", label: "Project Status" },
  { key: "project__url", label: "Project URL" },
  { key: "project__sourceUrl", label: "Source Video URL" },
  { key: "project__durationSec", label: "Source Duration (s)", type: "number" },
];

const clip = (prefix, labelPrefix) => [
  { key: `${prefix}id`, label: `${labelPrefix}ID` },
  { key: `${prefix}title`, label: `${labelPrefix}Title` },
  { key: `${prefix}hook`, label: `${labelPrefix}Hook` },
  { key: `${prefix}caption`, label: `${labelPrefix}Caption` },
  { key: `${prefix}hashtags`, label: `${labelPrefix}Hashtags`, list: true },
  { key: `${prefix}score`, label: `${labelPrefix}Score`, type: "number" },
  { key: `${prefix}durationSec`, label: `${labelPrefix}Duration (s)`, type: "number" },
  { key: `${prefix}status`, label: `${labelPrefix}Status` },
  { key: `${prefix}url`, label: `${labelPrefix}URL in Reelsaw` },
  { key: `${prefix}shareUrl`, label: `${labelPrefix}Share Link (MP4, no sign-in)` },
  { key: `${prefix}thumbnailShareUrl`, label: `${labelPrefix}Thumbnail Share Link (JPEG, no sign-in)` },
  { key: `${prefix}videoUrl`, label: `${labelPrefix}Video URL (needs API key)` },
];

const projectDone = [
  ...project,
  { key: "clipCount", label: "Clip Count", type: "integer" },
  { key: "renderedClipCount", label: "Rendered Clip Count", type: "integer" },
  { key: "exportShareUrl", label: "Export Zip Share Link (no sign-in)" },
  { key: "exportUrl", label: "Export Zip URL (needs API key)" },
  ...clip("clips[]", "Clip "),
];

const clipDone = [...project, ...clip("clip__", "Clip "), { key: "clip__renderGen", label: "Render Generation", type: "integer" }];

const projectFailed = [...project, { key: "stage", label: "Failed Stage" }, { key: "error", label: "Error" }];

module.exports = { projectDone, clipDone, projectFailed };
