/**
 * Forwards pino lines to the OpenTelemetry logger. otel.ts turns this on after the SDK
 * has registered its logger provider (which exports to OTEL_EXPORTER_OTLP_ENDPOINT/v1/logs).
 * The line is already pino's redacted JSON. Strings are then passed through the same value
 * scrubber issue reports use. Importing this module does not load pino.
 */
import { logs, type SeverityNumber } from "@opentelemetry/api-logs";
import { otelLogFromLine } from "./otel-config.js";
import { scrubOutboundText } from "./report/redact.js";

let enabled = false;
let secrets: readonly string[] = [];

export function setOtelLogsEnabled(on: boolean): void {
  enabled = on;
}

/** Configured secret values, once config has loaded. Patterns apply either way. */
export function setOtelLogScrubber(values: readonly string[]): void {
  secrets = values;
}

export function forwardPinoLine(line: string): void {
  if (!enabled) return;
  const rec = otelLogFromLine(line, (text) => scrubOutboundText(text, secrets));
  if (!rec) return;
  logs.getLogger("reelsaw").emit({
    severityNumber: rec.severityNumber as SeverityNumber,
    severityText: rec.severityText,
    body: rec.body,
    attributes: rec.attributes,
  });
}
