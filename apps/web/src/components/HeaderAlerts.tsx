/**
 * Status chips for the top bar and the editor header (jobs paused, a stale bundle).
 * Desktop shows each chip with its full label. At 390 px they would overflow or collapse to a
 * glyph (hover-only, against PRINCIPLES.md): one alert keeps a short word; two or more fold
 * into a "N alerts" chip that opens a menu of the full items.
 */
import { Link } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMe, useSystemStatus } from "../lib/account";
import { refreshForNewVersion, useStaleChunkNudge } from "../lib/stale-chunk";
import { useUnsaved } from "../lib/unsaved";

type Tone = "acc" | "warn" | "err";
const TONE: Record<Tone, string> = { acc: "bg-acc-soft", warn: "bg-warn-soft", err: "bg-err-soft" };

export interface HeaderAlert {
  id: string;
  glyph: string;
  /** Compact label for a 390 px bar (always visible; never tooltip-only). */
  short: string;
  /** Full label for sm+ chips and the overflow menu. */
  label: string;
  detail: string;
  tone: Tone;
  href?: string;
  onClick?: () => void;
}

export function useHeaderAlerts(): HeaderAlert[] {
  // workers report what they are short of every 15 s (ops/workers.ts), so polling faster only repeats the same answer
  const paused = useSystemStatus(30_000).data?.paused;
  const isAdmin = useMe().data?.role === "admin";
  const stale = useStaleChunkNudge();
  const dirty = useUnsaved();
  const alerts: HeaderAlert[] = [];
  if (stale) {
    alerts.push({
      id: "stale",
      glyph: "↑",
      short: dirty ? "Save first" : "Refresh",
      label: dirty ? "Save, then refresh" : "Newer version · Refresh",
      detail: dirty ? "A newer version is ready. Refreshing now would discard unsaved edits." : "This tab is running an older version.",
      tone: "acc",
      onClick: refreshForNewVersion,
    });
  }
  if (paused) {
    const reason = paused === "disk" ? "disk nearly full" : `${paused} busy`;
    alerts.push({
      id: "paused",
      glyph: "◷",
      short: "Paused",
      label: `Jobs paused · ${reason}`,
      detail: "Heavy jobs wait until a worker has room",
      tone: "warn",
      // admins land on the workers that are short; everyone else has nothing to change, so it stays a note
      ...(isAdmin ? { href: "/settings/system#workers" } : {}),
    });
  }
  return alerts;
}

function AlertChip({ alert, compact }: { alert: HeaderAlert; compact?: boolean }) {
  const className = `chip min-w-0 shrink-0 ${TONE[alert.tone]} text-ink no-underline`;
  const inner = (
    <>
      <span className="relative -top-px font-mono leading-none" aria-hidden>
        {alert.glyph}
      </span>
      {compact ? alert.short : alert.label}
    </>
  );
  if (alert.href) {
    return (
      <Link to={alert.href} className={className} title={alert.detail} aria-label={alert.detail}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" className={className} title={alert.detail} aria-label={alert.detail} onClick={alert.onClick}>
      {inner}
    </button>
  );
}

function AlertsMenu({ alerts }: { alerts: HeaderAlert[] }) {
  const tone: Tone = alerts.some((a) => a.tone === "err") ? "err" : alerts.some((a) => a.tone === "warn") ? "warn" : "acc";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={`chip min-w-0 shrink-0 ${TONE[tone]} text-ink`} aria-label={alerts.map((a) => a.detail).join(". ")}>
          <span className="relative -top-px font-mono leading-none" aria-hidden>
            {alerts[0]!.glyph}
          </span>
          {alerts.length} alerts
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="menu">
          {alerts.map((a) =>
            a.href ? (
              <DropdownMenu.Item key={a.id} className="menu-item" asChild>
                <Link to={a.href}>
                  <span className="font-mono" aria-hidden>
                    {a.glyph}
                  </span>
                  {a.label}
                </Link>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item key={a.id} className="menu-item" onSelect={a.onClick}>
                <span className="font-mono" aria-hidden>
                  {a.glyph}
                </span>
                {a.label}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function HeaderAlerts() {
  const alerts = useHeaderAlerts();
  if (!alerts.length) return null;
  return (
    <>
      <div className="hidden shrink-0 items-center gap-2 sm:flex">
        {alerts.map((a) => (
          <AlertChip key={a.id} alert={a} />
        ))}
      </div>
      <div className="shrink-0 sm:hidden">{alerts.length === 1 ? <AlertChip alert={alerts[0]!} compact /> : <AlertsMenu alerts={alerts} />}</div>
    </>
  );
}
