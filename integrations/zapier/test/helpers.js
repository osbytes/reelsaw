"use strict";

const nock = require("nock");

const BASE = "https://reelsaw.test";
const KEY = "rs_test_0123456789abcdef";
const authData = { baseUrl: BASE, apiKey: KEY };

/** A tool answer as /api/mcp sends it: JSON in result.content[0].text. */
const ok = (data) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] } });
/** A tool error as /api/mcp sends it: isError with "CODE: sentence". */
const toolError = (text) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError: true } });

/**
 * Expect one tools/call of `name` and answer it. Returns a record of what was sent (arguments, headers), filled in
 * when the request arrives.
 */
function mockTool(name, reply, { status = 200, base = BASE } = {}) {
  const seen = { called: false, arguments: undefined, headers: undefined };
  nock(base)
    .post("/api/mcp", (body) => body && body.method === "tools/call" && body.params && body.params.name === name)
    .reply(function (_uri, body) {
      seen.called = true;
      seen.arguments = body.params.arguments;
      seen.headers = this.req.headers;
      seen.body = body;
      return [status, reply, { "content-type": "application/json" }];
    });
  return seen;
}

module.exports = { BASE, KEY, authData, ok, toolError, mockTool, nock };
