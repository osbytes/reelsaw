/**
 * Who may download a report zip, include instance system/errors, or send feedback through
 * Sentry/PostHog. Hosted (REELSAW_EE) non-admins must not pull instance-wide system info or
 * error logs; when telemetry is on they report through those channels instead of a zip.
 * Instance-wide unfinished work / other accounts' failures is admin-only even on self-host.
 */
import type { ReportInclude } from "@reelsaw/shared";
import type { Services } from "../services.js";
import type { UserRole } from "../db/schema.js";

export type ReportCapabilities = {
  /** download a zip of own project/account data */
  zip: boolean;
  /** include system.json / queue / usage / errors.jsonl in that zip */
  system: boolean;
  /** include unfinished work, failed jobs and errors across every account (admin only) */
  instance: boolean;
  /** Sentry and/or PostHog are configured for this instance */
  feedback: boolean;
};

export function reportCapabilities(
  svc: Pick<Services, "ee" | "telemetry">,
  user: { role: UserRole },
): ReportCapabilities {
  const hosted = !!svc.ee;
  const admin = user.role === "admin";
  const feedback = svc.telemetry.enabled.sentry || svc.telemetry.enabled.posthog;
  // hosted + telemetry: normal users send feedback only; self-host and admins keep the zip
  const zip = !hosted || admin || !feedback;
  const system = !hosted || admin;
  return { zip, system, instance: admin, feedback };
}

/** Force include.system / include.instance off when the caller may not see them. Instance implies system. */
export function applyReportInclude(caps: ReportCapabilities, include: ReportInclude): ReportInclude {
  const instance = caps.instance && include.instance;
  return {
    ...include,
    system: (caps.system && include.system) || instance,
    instance,
  };
}
