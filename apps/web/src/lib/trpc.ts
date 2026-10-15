import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import type { AppRouter } from "@reelsaw/server";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export function makeTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: httpSubscriptionLink({ url: "/api/trpc", eventSourceOptions: { withCredentials: true } }),
        false: httpBatchLink({ url: "/api/trpc", fetch: (url, opts) => fetch(url, { ...opts, credentials: "include" }) }),
      }),
    ],
  });
}
