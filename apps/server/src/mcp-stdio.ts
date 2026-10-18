/**
 * `reelsaw mcp`: the MCP server over stdio, for clients that launch a command instead of calling
 * a URL with a header (Claude Desktop without OAuth, Cursor's stdio entries, registry checks). It
 * advertises the same tools as `/api/mcp` (`mcp-tools.ts`) and forwards every call to a running
 * Reelsaw over Streamable HTTP, so it needs no database, models or queue: it starts anywhere the
 * image or the source tree runs.
 *
 *   REELSAW_URL      the instance to drive (default http://localhost:$PORT, i.e. the app in this container)
 *   REELSAW_API_KEY  an API key from Settings → API keys and MCP (required for every call)
 *
 * stdout is the protocol channel, so nothing else may write to it; logs go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import { createLogger, type Logger } from "./log.js";
import { INSTRUCTIONS, TOOLS, argSummary, fail } from "./mcp-tools.js";

export interface StdioEnv {
  REELSAW_URL?: string;
  REELSAW_API_KEY?: string;
  PORT?: string;
  REELSAW_VERSION?: string;
  CLI_LOG_LEVEL?: string;
}

/** The longest a forwarded call may take: wait_for_project blocks for up to 120 s, plus slack. */
const CALL_TIMEOUT_MS = 180_000;

export function resolveUrl(env: StdioEnv): URL {
  return new URL("/api/mcp", env.REELSAW_URL ?? `http://localhost:${env.PORT ?? "3000"}`);
}

/** Opens one connected client to the remote instance; the bridge keeps it for every later call. */
export type RemoteFactory = (url: URL, apiKey: string) => Promise<Client>;

export const connectRemote: RemoteFactory = async (url, apiKey) => {
  const client = new Client({ name: "reelsaw-stdio", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
  return client;
};

export interface StdioBridge {
  server: McpServer;
  /** Close the remote client (if a call ever opened it). */
  close(): Promise<void>;
}

type ToolConfig = { title?: string; description?: string; inputSchema?: ZodRawShape; annotations?: ToolAnnotations };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * The bridge server: the full tool catalogue, each tool forwarding to the remote instance. Listing
 * tools needs no connection; a call without an API key, or to an unreachable instance, returns a
 * tool error that says what to set.
 */
export function createStdioBridge(env: StdioEnv, log: Logger, connect: RemoteFactory = connectRemote): StdioBridge {
  const url = resolveUrl(env);
  const apiKey = env.REELSAW_API_KEY;
  const server = new McpServer({ name: "reelsaw", version: env.REELSAW_VERSION ?? "dev" }, { instructions: INSTRUCTIONS });

  let remote: Promise<Client> | undefined;
  const client = () => {
    if (!apiKey) throw new Error(`REELSAW_API_KEY is not set. Create a key in Settings → API keys and MCP of ${url.origin} and pass it in the environment of this command.`);
    remote ??= connect(url, apiKey).catch((err) => {
      remote = undefined; // the next call tries again (the instance may still be starting)
      throw new Error(`Cannot reach Reelsaw at ${url} (${err instanceof Error ? err.message : String(err)}). Set REELSAW_URL to the address of a running instance.`);
    });
    return remote;
  };

  const forward = async (name: string, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
    const tlog = log.child({ tool: name });
    tlog.debug({ args: argSummary(args) }, "mcp tool call");
    try {
      const c = await client();
      const res = (await c.callTool({ name, arguments: args }, undefined, { signal: extra.signal, timeout: CALL_TIMEOUT_MS })) as CallToolResult;
      tlog[res.isError ? "warn" : "info"]({ ok: !res.isError, forwarded: true }, "mcp tool");
      return res;
    } catch (err) {
      tlog.warn({ err }, "mcp tool forward failed");
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  for (const [name, config] of Object.entries(TOOLS) as Array<[string, ToolConfig]>) {
    // the SDK passes (args, extra) to a tool with an input schema and only (extra) to one without
    const { inputSchema, ...rest } = config;
    if (inputSchema) server.registerTool(name, { ...rest, inputSchema }, (args, extra) => forward(name, args as Record<string, unknown>, extra));
    else server.registerTool(name, rest, (extra) => forward(name, {}, extra));
  }

  return {
    server,
    close: async () => {
      const c = await remote?.catch(() => undefined);
      await c?.close().catch(() => {});
    },
  };
}

/** Serve the bridge on this process's stdin/stdout until the client closes the stream. */
export async function runMcpStdio(env: StdioEnv): Promise<void> {
  const log = createLogger({ LOG_LEVEL: env.CLI_LOG_LEVEL ?? "warn", LOG_FORMAT: "json" }, { module: "mcp-stdio" }, process.stderr);
  const bridge = createStdioBridge(env, log);
  const closed = new Promise<void>((resolve) => {
    bridge.server.server.onclose = () => resolve();
  });
  await bridge.server.connect(new StdioServerTransport());
  log.info({ url: resolveUrl(env).origin }, "mcp stdio bridge started");
  await closed;
  await bridge.close();
}
