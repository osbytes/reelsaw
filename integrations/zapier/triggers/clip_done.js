"use strict";

const { hookTrigger } = require("../lib/hook");
const { callTool } = require("../lib/mcp");
const { sampleClipDone } = require("../lib/payloads");
const fields = require("../lib/fields");

/** Samples for the Zap editor: up to 3 rendered clips of the user's most recently updated finished project. */
const performList = async (z, bundle) => {
  const page = await callTool(z, bundle, "list_projects", { limit: 25 });
  const latest = (page.projects || []).find((p) => p.status === "done");
  if (!latest) return [];
  const project = await callTool(z, bundle, "get_project", { id: latest.id });
  return (project.clips || [])
    .filter((c) => c.status === "done")
    .slice(0, 3)
    .map((c) => sampleClipDone(project, c));
};

module.exports = hookTrigger({
  key: "clip_done",
  noun: "Clip",
  label: "Clip Rendered",
  description: "Triggers when a clip finishes rendering (clip.done), each time: re-renders and clips you add by hand included.",
  event: "clip.done",
  performList,
  outputFields: fields.clipDone,
});
