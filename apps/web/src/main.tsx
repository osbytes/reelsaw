import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { TRPCProvider, makeTrpcClient } from "./lib/trpc";
import { App } from "./App";
import "./index.css";
import { installDiagnostics } from "./lib/diagnostics";
import { bootOtel } from "./lib/otel";
import { installStaleChunkHandler } from "./lib/stale-chunk";
import { authClient } from "./lib/auth";
import { setSseUnauthorizedHandler } from "./lib/sse";

installDiagnostics();
installStaleChunkHandler();

async function main() {
  // Tracing is on before the first tRPC call, including system.status. The /api/otel fetch
  // that Vite dev uses to learn the config is the one request that happens first.
  await bootOtel();
  // An expired session answers 401: refetch the session so the app's own redirect to /login runs without a reload.
  const refetchSession = () => authClient.$store.notify("$sessionSignal");
  const isUnauthorized = (err: unknown) => err instanceof TRPCClientError && err.data?.code === "UNAUTHORIZED";
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: (n, err) => !isUnauthorized(err) && n < 1, staleTime: 5_000 } },
    queryCache: new QueryCache({ onError: (err) => isUnauthorized(err) && refetchSession() }),
    mutationCache: new MutationCache({ onError: (err) => isUnauthorized(err) && refetchSession() }),
  });
  setSseUnauthorizedHandler(refetchSession);
  const trpcClient = makeTrpcClient();
  // a data router (the app's own <Routes> live under one splat route) so editors can block leaving with unsaved edits
  const router = createBrowserRouter([{ path: "*", element: <App /> }]);
  ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>
  </React.StrictMode>,
  );
}

void main();
