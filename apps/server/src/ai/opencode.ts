/**
 * OpenCode (opencode.ai): one Console key, two plans, both OpenAI-compatible chat completions.
 *  - Zen (`opencode:<model>`): pay per token; paid models may be called from any client.
 *  - Go (`opencode-go:<model>`): a subscription with 5-hour, weekly and monthly caps, "designed for
 *    OpenCode and other coding agents". Go asks clients to send their own User-Agent and a stable
 *    `x-opencode-session` per conversation; here a conversation is a project (else the job).
 * Language models only: OpenCode has no speech-to-text. The key is stored once, under `opencode`
 * (ai/provider-ids.ts). Docs: https://opencode.ai/docs/zen/, https://opencode.ai/docs/go/
 */
import { randomUUID } from "node:crypto";
/** what @ai-sdk providers accept as `fetch` */
type FetchFunction = typeof globalThis.fetch;
import { llmContext } from "./trace.js";
import { OPENCODE_DEFAULT_BASE_URL } from "./provider-ids.js";

export type OpenCodePlan = "opencode" | "opencode-go";

/**
 * Per plan: the Chat Completions base and the model list, both relative to OPENCODE_BASE_URL, and the
 * picker's section. The chat bases are the `api["chat-completions"].base_url` each plan's listing gives.
 */
export const OPENCODE_PLANS: Record<OpenCodePlan, { chat: string; models: string; group: string; notice?: string }> = {
  opencode: { chat: "/openai/v1", models: "/v1/models", group: "OpenCode Zen" },
  "opencode-go": {
    chat: "/go/openai/v1",
    models: "/go/v1/models",
    group: "OpenCode Go",
    notice:
      "Go is a subscription meant for coding agents: traffic is monitored, and any 5 hours may use at most 20% of the month. A long video makes many calls; Zen bills per token instead.",
  },
};

export const isOpenCodePlan = (provider: string): provider is OpenCodePlan => provider in OPENCODE_PLANS;

export const opencodeUserAgent = (version: string) => `reelsaw/${version}`;

// calls outside any project or job (a model test, boot) still share one session per process
const processSession = randomUUID();

/** The session Go sees for the call in progress: its project, else its job, else this process. */
export function opencodeSession(): string {
  const ctx = llmContext();
  return ctx.projectId ?? ctx.jobId ?? processSession;
}

/**
 * `fetch` that sets Reelsaw's User-Agent and, for Go, `x-opencode-session`, on every request. Set here,
 * last, because the AI SDK writes its own `ai/<version>` user agent over the provider's `headers` option,
 * and Go asks clients not to send a generic SDK name. The session is read when the request is sent.
 */
export function withOpencodeHeaders(version: string, opts: { session: boolean }, base: FetchFunction = fetch): FetchFunction {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", opencodeUserAgent(version));
    if (opts.session) headers.set("x-opencode-session", opencodeSession());
    return base(input, { ...init, headers });
  };
}

/** The two providers, built from the shared key. `fetchImpl` is for tests. */
export async function createOpenCodeProviders(o: {
  /** OPENCODE_BASE_URL; empty or missing (a partial test config) means the default */
  baseUrl: string | undefined;
  apiKey: string | undefined;
  version: string;
  structuredOutputs: boolean;
  fetchImpl?: FetchFunction;
}) {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const root = (o.baseUrl || OPENCODE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const make = (plan: OpenCodePlan) =>
    createOpenAICompatible({
      name: plan,
      baseURL: root + OPENCODE_PLANS[plan].chat,
      apiKey: o.apiKey ?? "none",
      supportsStructuredOutputs: o.structuredOutputs,
      fetch: withOpencodeHeaders(o.version, { session: plan === "opencode-go" }, o.fetchImpl),
    });
  return { opencode: make("opencode"), "opencode-go": make("opencode-go") };
}
