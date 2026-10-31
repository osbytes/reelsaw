"use strict";

const { callTool, isNotFound } = require("../lib/mcp");
const { projectOutput, projectOutputFields } = require("../lib/project");
const { SAMPLE_BODIES } = require("../lib/payloads");

/** get_project by id. Not found (or not yours) is an empty result, so the Zap's "found / not found" paths work. */
const perform = async (z, bundle) => {
  const id = String(bundle.inputData.projectId || "").trim();
  if (!id) return [];
  try {
    return [projectOutput(await callTool(z, bundle, "get_project", { id }))];
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
};

const sampleDone = SAMPLE_BODIES["project.done"].data;

module.exports = {
  key: "find_project",
  noun: "Project",
  display: {
    label: "Find Project",
    description: "Finds one of your projects by its ID, with its status and clips.",
  },
  operation: {
    inputFields: [
      {
        key: "projectId",
        label: "Project ID",
        required: true,
        helpText: "The project's ID, for example from **Create Project** or a Reelsaw trigger (Project ID).",
      },
    ],
    perform,
    sample: projectOutput({
      ...sampleDone.project,
      stage: null,
      error: null,
      updatedAt: SAMPLE_BODIES["project.done"].createdAt,
      metadata: SAMPLE_BODIES["project.done"].metadata,
      exportZipUrl: sampleDone.exportUrl,
      clips: sampleDone.clips,
    }),
    outputFields: projectOutputFields,
  },
};
