"use strict";

const { normalizeBaseUrl } = require("./mcp");

/**
 * Adds the API key as `Authorization: Bearer rs_…`, only on requests to the connected Reelsaw instance, so the key
 * never goes to another host (a share link, a file a later step fetches).
 */
const includeBearer = (request, z, bundle) => {
  const key = bundle.authData && bundle.authData.apiKey && String(bundle.authData.apiKey).trim();
  if (!key || !request.url) return request;
  let base;
  try {
    base = normalizeBaseUrl(bundle.authData.baseUrl);
  } catch {
    return request;
  }
  if (request.url === base || request.url.startsWith(`${base}/`)) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${key}`;
  }
  return request;
};

module.exports = { befores: [includeBearer], afters: [] };
