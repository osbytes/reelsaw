import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import type { AppRouter } from "@reelsaw/server";
import { FetchEventSource } from "./sse";
import { noteServerBuild } from "./stale-chunk";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export function makeTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: httpSubscriptionLink({
          url: "/api/trpc",
          // fetch, not EventSource, so the request carries traceparent (see lib/sse.ts)
          EventSource: FetchEventSource,
          eventSourceOptions: { withCredentials: true },
        }),
        false: httpBatchLink({
          url: "/api/trpc",
          fetch: async (url, opts) => {
            const res = await fetch(url, { ...opts, credentials: "include" });
            noteServerBuild(res.headers.get("x-reelsaw-build"));
            return res;
          },
        }),
      }),
    ],
  });
}
