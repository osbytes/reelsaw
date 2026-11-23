import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import type { AppRouter } from "@reelsaw/server";
import { FetchEventSource } from "./sse";
import { noteServerBuild } from "./stale-chunk";
import { activeLocale } from "./i18n";

/** Errors and notices come back in the app's language (apps/server/src/i18n.ts). */
const localeHeaders = () => ({ "x-reelsaw-locale": activeLocale() });

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
          eventSourceOptions: () => ({ withCredentials: true, headers: localeHeaders() }),
        }),
        false: httpBatchLink({
          url: "/api/trpc",
          headers: localeHeaders,
          fetch: async (url, opts) => {
            // tRPC types `signal` as `AbortSignal | undefined`, which RequestInit does not allow with exactOptionalPropertyTypes
            const res = await fetch(url, { ...(opts as RequestInit | undefined), credentials: "include" });
            noteServerBuild(res.headers.get("x-reelsaw-build"));
            return res;
          },
        }),
      }),
    ],
  });
}
