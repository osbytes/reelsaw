"use strict";

const { hookTrigger } = require("../lib/hook");
const { callTool } = require("../lib/mcp");
const { sampleProjectFailed } = require("../lib/payloads");
const fields = require("../lib/fields");

/** Samples for the Zap editor: up to 3 of the user's failed projects, shaped like a project.failed delivery. */
const performList = async (z, bundle) => {
  const page = await callTool(z, bundle, "list_projects", { limit: 25 });
  const failed = (page.projects || []).filter((p) => p.status === "failed").slice(0, 3);
  const items = [];
  for (const p of failed) items.push(sampleProjectFailed(await callTool(z, bundle, "get_project", { id: p.id })));
  return items;
};

module.exports = hookTrigger({
  key: "project_failed",
  noun: "Project",
  label: "Project Failed",
  description: "Triggers when a project's run fails (project.failed), with the stage and the reason Reelsaw shows.",
  event: "project.failed",
  performList,
  outputFields: fields.projectFailed,
});
