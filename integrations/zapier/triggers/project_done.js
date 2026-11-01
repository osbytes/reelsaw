"use strict";

const { hookTrigger } = require("../lib/hook");
const { callTool } = require("../lib/mcp");
const { sampleProjectDone } = require("../lib/payloads");
const fields = require("../lib/fields");

/** Samples for the Zap editor: up to 3 of the user's finished projects, shaped like a project.done delivery. */
const performList = async (z, bundle) => {
  const page = await callTool(z, bundle, "list_projects", { limit: 25 });
  const done = (page.projects || []).filter((p) => p.status === "done").slice(0, 3);
  const items = [];
  for (const p of done) items.push(sampleProjectDone(await callTool(z, bundle, "get_project", { id: p.id })));
  return items;
};

module.exports = hookTrigger({
  key: "project_done",
  noun: "Project",
  label: "Project Finished",
  description:
    "Triggers when a project finishes (project.done), once, with every clip as line items, share links that need no sign-in, and the export zip.",
  event: "project.done",
  performList,
  outputFields: fields.projectDone,
});
