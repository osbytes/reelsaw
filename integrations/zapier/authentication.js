"use strict";

const { callTool, normalizeBaseUrl } = require("./lib/mcp");

/** The cheapest authenticated call: one project from list_projects. Proves the address is Reelsaw and the key works. */
const test = async (z, bundle) => {
  const page = await callTool(z, bundle, "list_projects", { limit: 1 });
  const base = normalizeBaseUrl(bundle.authData.baseUrl);
  return { instance: new URL(base).host, baseUrl: base, totalProjects: typeof page.total === "number" ? page.total : null };
};

module.exports = {
  type: "custom",
  fields: [
    {
      key: "baseUrl",
      label: "Reelsaw Address",
      type: "string",
      required: true,
      default: "https://app.reelsaw.com",
      helpText:
        "Where your Reelsaw runs: `https://app.reelsaw.com` for hosted Reelsaw, or your own instance's public address (for example `https://clips.example.com`).",
    },
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      helpText:
        "In Reelsaw, open [Settings → API keys and MCP](https://app.reelsaw.com/settings) (on your own instance: Settings in its menu) and create a key. It starts with `rs_` and is shown once.",
    },
  ],
  test,
  connectionLabel: "{{instance}}",
};
