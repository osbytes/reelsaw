/**
 * Error reporting (Sentry) and product analytics (PostHog), both optional and off unless their keys are set:
 * nothing is initialised, nothing is sent, no code path changes. One service, used from the few places where
 * the facts are known: boot and process-level failures (main.ts), 5xx tRPC errors (http.ts), a job's final
 * failed attempt (queue/workers.ts), committed project events (uow.ts), sign-ups (auth.ts), billing
 * transitions (ee/billing) and abuse flags (abuse.ts). The browser gets the public keys from `system.status`
 * and its own init (apps/web/src/lib/telemetry.ts).
 *
 * Identity: the user id is the distinct id; email and name go to PostHog's person profile (it is the
 * operator's own analytics of their own users), never to Sentry (no PII is attached: user id only). Prompts, transcripts
 * and media never leave through here; event properties are ids, counts and names.
 */
import * as Sentry from "@sentry/node";
import { PostHog } from "posthog-node";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

export interface TelemetryPublic {
  sentry: { dsn: string; environment: string; release: string } | null;
  posthog: { key: string; host: string } | null;
}

export interface Telemetry {
  enabled: { sentry: boolean; posthog: boolean };
  /** what the browser needs: public values only */
  public: TelemetryPublic;
  /** an error a person must look at (also logged by the caller); tags are ids and names, never bodies */
  captureException(err: unknown, tags?: Record<string, string | number | boolean | null | undefined>): void;
  /** a product event for one account */
  capture(event: string, distinctId: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties: Record<string, unknown>): void;
  /** flush what is queued (shutdown) */
  shutdown(): Promise<void>;
}

export function createTelemetry(config: Pick<Config, "SENTRY_DSN" | "SENTRY_ENVIRONMENT" | "POSTHOG_KEY" | "POSTHOG_HOST" | "REELSAW_VERSION" | "NODE_ENV">, log: Logger): Telemetry {
  const release = `reelsaw@${config.REELSAW_VERSION}`;
  const environment = config.SENTRY_ENVIRONMENT ?? (config.NODE_ENV === "production" ? "production" : "development");
  const sentry = !!config.SENTRY_DSN;
  if (sentry) Sentry.init({ dsn: config.SENTRY_DSN, environment, release, tracesSampleRate: 0 });
  const posthog = config.POSTHOG_KEY ? new PostHog(config.POSTHOG_KEY, { host: config.POSTHOG_HOST, flushAt: 20, flushInterval: 10_000 }) : null;
  if (posthog) posthog.on("error", (err: unknown) => log.warn({ err }, "posthog send failed"));
  if (sentry || posthog) log.info({ sentry, posthog: !!posthog, environment, release }, "telemetry on");
  return {
    enabled: { sentry, posthog: !!posthog },
    public: {
      sentry: sentry ? { dsn: config.SENTRY_DSN!, environment, release } : null,
      posthog: posthog ? { key: config.POSTHOG_KEY!, host: config.POSTHOG_HOST } : null,
    },
    captureException(err, tags) {
      if (!sentry) return;
      const clean = Object.fromEntries(Object.entries(tags ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
      Sentry.captureException(err, { tags: clean });
    },
    capture(event, distinctId, properties) {
      posthog?.capture({ distinctId, event, properties: { ...properties, $lib_custom: "reelsaw-server", release } });
    },
    identify(distinctId, properties) {
      posthog?.identify({ distinctId, properties });
    },
    async shutdown() {
      await posthog?.shutdown().catch(() => {});
      if (sentry) await Sentry.close(2000).catch(() => {});
    },
  };
}
