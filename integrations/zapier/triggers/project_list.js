"use strict";

const { callTool } = require("../lib/mcp");

/**
 * Hidden: the Project dropdown on Get Share Links and Find Project. The 100 most recently updated projects
 * (list_projects' largest page); an older one is still reachable by mapping or typing its ID.
 */
const perform = async (z, bundle) => {
  const page = await callTool(z, bundle, "list_projects", { limit: 100 });
  return (page.projects || []).map((p) => ({ id: p.id, title: p.title, status: p.status, clips: p.clips ?? null }));
};

module.exports = {
  key: "project_list",
  noun: "Project",
  display: { label: "List Projects", description: "Lists your projects for a dropdown.", hidden: true },
  operation: {
    perform,
    sample: { id: "3f6d2b9e-7c41-4a8e-9b1d-5e0f2a6c8d47", title: "Shipping on Fridays", status: "done", clips: "8/8 rendered" },
    outputFields: [
      { key: "id", label: "Project ID" },
      { key: "title", label: "Title" },
      { key: "status", label: "Status" },
    ],
  },
};
