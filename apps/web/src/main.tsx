import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCProvider, makeTrpcClient } from "./lib/trpc";
import { App } from "./App";
import "./index.css";
import { installDiagnostics } from "./lib/diagnostics";
import { bootOtel } from "./lib/otel";

installDiagnostics();

async function main() {
  // Tracing is on before the first tRPC call, including system.status. The /api/otel fetch
  // that Vite dev uses to learn the config is the one request that happens first.
  await bootOtel();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } });
  const trpcClient = makeTrpcClient();
  ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </TRPCProvider>
    </QueryClientProvider>
  </React.StrictMode>,
  );
}

void main();
