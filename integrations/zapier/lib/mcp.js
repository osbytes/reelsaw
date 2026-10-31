"use strict";

/**
 * Every call to Reelsaw goes through its MCP endpoint (docs/PRINCIPLES.md, "Integrations go through MCP"):
 * `POST {baseUrl}/api/mcp` with a JSON-RPC `tools/call`. The endpoint is stateless and answers plain JSON, so one
 * tool call is one HTTP request. A tool error comes back as `result.isError` with "CODE: sentence" in its content;
 * that sentence becomes the Zapier error the user sees.
 */

/** The instance's origin from what the user typed: trims, adds https://, and drops a pasted /api/mcp or trailing slash. */
function normalizeBaseUrl(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "https://app.reelsaw.com";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, "").replace(/\/api\/mcp$/i, "");
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`"${raw}" is not a web address. Use your Reelsaw address, for example https://app.reelsaw.com.`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const mcpUrl = (bundle) => `${normalizeBaseUrl(bundle.authData && bundle.authData.baseUrl)}/api/mcp`;

/** "NOT_FOUND: Project not found\n{…quota…}" → { code: "NOT_FOUND", message: "Project not found" } */
function parseToolError(text) {
  const firstLine = String(text ?? "").split("\n")[0].trim();
  const m = /^([A-Z_]{4,}):\s*(.*)$/.exec(firstLine);
  return m ? { code: m[1], message: m[2] || m[1] } : { code: "REELSAW_ERROR", message: firstLine || "Reelsaw could not do that." };
}

let rpcId = 0;

/**
 * Call one Reelsaw MCP tool and return its parsed result. Throws a Zapier error whose message is Reelsaw's own
 * sentence for tool errors, and a plain sentence for HTTP failures (bad key, wrong address, instance down).
 */
async function callTool(z, bundle, name, args = {}) {
  const response = await z.request({
    url: mcpUrl(bundle),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
    skipThrowForStatus: true,
  });

  let json;
  try {
    json = typeof response.data === "object" && response.data !== null ? response.data : JSON.parse(response.content);
  } catch {
    json = undefined;
  }

  if (response.status === 401) {
    throw new z.errors.ExpiredAuthError("Reelsaw did not accept this API key. Create a new one in Reelsaw under Settings → API keys and MCP and reconnect.");
  }
  if (response.status === 403) {
    throw new z.errors.Error((json && json.message) || "Reelsaw refused this account (it may be waiting for approval or blocked).", "Forbidden", 403);
  }
  if (response.status === 429) {
    const retry = Number(response.getHeader && response.getHeader("retry-after")) || 60;
    throw new z.errors.ThrottledError("Reelsaw is rate limiting this account; Zapier will try again shortly.", retry);
  }
  if (response.status >= 400 || !json) {
    const where = mcpUrl(bundle);
    throw new z.errors.Error(
      response.status >= 400
        ? `Reelsaw at ${where} answered ${response.status}. Check the Reelsaw address in the connection and that the instance is running.`
        : `${where} did not answer like a Reelsaw instance. Check the Reelsaw address in the connection.`,
      "BadResponse",
      response.status,
    );
  }
  if (json.error) {
    throw new z.errors.Error(json.error.message || "Reelsaw could not run that request.", "McpError", response.status);
  }

  const result = json.result || {};
  const text = result.content && result.content[0] && typeof result.content[0].text === "string" ? result.content[0].text : "";
  if (result.isError) {
    const { code, message } = parseToolError(text);
    const err = new z.errors.Error(message, code, response.status);
    err.reelsawCode = code;
    throw err;
  }
  if (result.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** true when a callTool error was Reelsaw saying the thing does not exist (or is not yours). */
const isNotFound = (err) => !!err && (err.reelsawCode === "NOT_FOUND" || err.code === "NOT_FOUND");

module.exports = { callTool, normalizeBaseUrl, parseToolError, isNotFound, mcpUrl };
