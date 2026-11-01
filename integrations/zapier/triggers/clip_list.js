"use strict";

const { callTool, isNotFound } = require("../lib/mcp");

/**
 * Hidden: the Clip dropdown on Get Share Links, for the project picked above it (projectId alters this field). Only
 * rendered clips: the others have nothing to link yet.
 */
const perform = async (z, bundle) => {
  const id = String((bundle.inputData && bundle.inputData.projectId) || "").trim();
  if (!id) return [];
  let project;
  try {
    project = await callTool(z, bundle, "get_project", { id });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return (project.clips || [])
    .filter((c) => c.status === "done")
    .map((c) => ({ id: c.id, title: `#${(c.index ?? 0) + 1} ${c.title}`, index: c.index, durationSec: c.durationSec ?? null }));
};

module.exports = {
  key: "clip_list",
  noun: "Clip",
  display: { label: "List Clips", description: "Lists a project's rendered clips for a dropdown.", hidden: true },
  operation: {
    perform,
    sample: { id: "a91c4e02-58b3-4d7f-8e26-0b7d3f1c9a65", title: "#1 Why we stopped deploying on Fridays", index: 0, durationSec: 42.5 },
    outputFields: [
      { key: "id", label: "Clip ID" },
      { key: "title", label: "Title" },
    ],
  },
};
