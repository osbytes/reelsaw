import { FontsSection } from "../components/FontsSection";
import { SignupRulesSection } from "../components/SignupRules";
import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, useLocation } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { ScrollArea } from "../components/scroll-area";
import { ApiKeysSection } from "../components/ApiKeys";
import { ShareLinksSection } from "../components/ShareLinks";
import { WebhooksSection } from "../components/Webhooks";
import { AccountSection } from "../components/AccountSection";
import { EmailSection } from "../components/EmailSection";
import { LocaleSection } from "../components/LocaleSection";
import { ConnectedAppsSection } from "../components/ConnectedApps";
import { ProjectDefaultsSection } from "../components/ProjectDefaults";
import { LearningSection } from "../components/LearningSection";
import { useMe, useSystemStatus } from "../lib/account";
import { ProcessingTimes } from "../components/ProcessingTimes";
import { WorkersSection } from "../components/WorkersSection";
import { FleetSummary } from "../components/FleetSummary";
import { QueueSection } from "../components/QueueSection";
import { ModelsSection } from "../components/ModelsSection";
import { ModelRetirementDot } from "../components/ModelRetirement";
import { LogLevelSection } from "../components/LogLevelSection";
import { Skeleton, SkeletonRegion } from "../components/ui";
import { UpdateBanner, UpdateStatusLine } from "../components/UpdateNotice";
import {
  ACCESS_FIELDS,
  InstanceSettingsGroup,
  LIBRARY_FIELDS,
  LIMIT_FIELDS,
  OPERATIONS_FIELDS,
  PIPELINE_FIELDS,
  RETENTION_FIELDS,
} from "../components/InstanceSettings";
import { BILLING_PATH, CHANGELOG_URL, REPO_URL, formatMb } from "@reelsaw/shared";
import { pageTitle, useDocumentTitle } from "../lib/title";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

// enterprise edition (src/ee, its own licence): the chunk is only requested when me.get says billing runs here
const BillingSection = lazy(() => import("../ee/billing/BillingSection"));

type Section = readonly [id: string, label: MessageDescriptor];

/** Your account's sections, in page order (/settings; /settings/billing lands on #billing). */
function accountSections(hasBilling: boolean, hasEmail: boolean): Section[] {
  return [
    ["profile", msg`Profile`],
    ["language", msg`Language and region`],
    // only when this instance sends mail; #email is the link in the ready email's footer
    ...(hasEmail ? ([["email", msg`Email`]] as const) : []),
    ...(hasBilling ? ([["billing", msg`Plan and billing`]] as const) : []),
    ["defaults", msg`Project defaults`],
    ["learning", msg`Learning`],
    ["api-keys", msg`API keys and MCP`],
    ["webhooks", msg`Webhooks`],
    ["share-links", msg`Share links`],
    ["connected-apps", msg`Connected apps`],
  ];
}

/** The instance's sections (admins, /settings/system), in page order. */
const SYSTEM_SECTIONS: Section[] = [
  ["overview", msg`Overview`],
  ["workers", msg`Workers`],
  ["queue", msg`Queue`],
  ["models", msg`Models`],
  ["access", msg`Access`],
  ["signup-rules", msg`Sign-up rules`],
  ["limits", msg`Limits`],
  ["pipeline", msg`Pipeline`],
  ["captions", msg`Captions`],
  ["retention", msg`Retention`],
  ["operations", msg`Operations`],
  ["library", msg`Library`],
  ["log-level", msg`Log level`],
];

/**
 * Settings has two tabs, each with its own side nav: Account (everyone: profile, plan and billing, project defaults,
 * keys) and System (admins: what the fleet runs and the settings that change without a restart). /settings and
 * /settings/system are the tabs; /settings/billing is Account scrolled to billing (Stripe returns there); #queue etc.
 * deep-links a section.
 */
export function SettingsPage() {
  const { t } = useLingui();
  const me = useMe();
  const status = useSystemStatus();
  const loc = useLocation();
  const isAdmin = me.data?.role === "admin";
  const hasBilling = !!me.data?.ee?.billing;
  const system = loc.pathname.endsWith("/system") && isAdmin;
  const hasEmail = !!me.data?.emailEnabled;
  const sections = system ? SYSTEM_SECTIONS : accountSections(hasBilling, hasEmail);
  useDocumentTitle(pageTitle(system ? t`System` : t`Settings`));
  const ids = sections.map(([id]) => id);
  const active = useActiveSection(ids, loc.pathname === BILLING_PATH ? "billing" : undefined);
  const tab = ({ isActive }: { isActive: boolean }) =>
    `rounded-[9px] px-3 py-[7px] text-[13px] whitespace-nowrap no-underline ${isActive ? "bg-sunk font-semibold text-ink" : "text-ink2 hover:text-ink"}`;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h1 className="text-[28px] font-bold tracking-tight">
                <Trans>Settings</Trans>
              </h1>
              <span className="min-h-5 font-mono text-xs text-ink3">
                {status.data ? (
                  <>
                    <a href={CHANGELOG_URL} target="_blank" rel="noreferrer" className="text-ink3 no-underline hover:text-acc-text">
                      <Trans>Reelsaw {status.data.version}</Trans>
                    </a>
                    {" · "}
                    <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-ink3 no-underline hover:text-acc-text">
                      {REPO_URL.replace(/^https:\/\//, "")}
                    </a>
                  </>
                ) : null}
              </span>
            </div>
            <p className="mt-1 min-h-5 text-sm text-ink2">
              {system ? (
                <Trans>What this instance runs and the settings that change without a restart; the rest comes from .env.</Trans>
              ) : (
                <Trans>Your account, your plan, your defaults for new projects, and keys for agents and tools.</Trans>
              )}
            </p>
          </div>
          {/* the tab row keeps its height for everyone, so the page does not jump when the role loads */}
          <nav className="flex min-h-[34px] gap-1" aria-label={t`Settings tabs`}>
            {isAdmin && (
              <>
                <NavLink to="/settings" end className={({ isActive }) => tab({ isActive: isActive || loc.pathname === BILLING_PATH })}>
                  <Trans>Account</Trans>
                </NavLink>
                <NavLink to="/settings/system" className={(s) => `${tab(s)} inline-flex items-center gap-1.5`}>
                  <Trans>System</Trans>
                  <ModelRetirementDot />
                </NavLink>
              </>
            )}
          </nav>
        </div>

        <div className="flex flex-col gap-4 md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:gap-6">
          <SideNav sections={sections} active={active} users={system} />
          <div className="flex min-w-0 flex-col gap-6">{system ? <SystemTab /> : <AccountTab hasBilling={hasBilling} hasEmail={hasEmail} />}</div>
        </div>
      </main>
    </ScrollArea>
  );
}

const linkClass = (on: boolean) =>
  `flex items-center gap-1.5 rounded-[9px] px-3 py-[7px] text-[13px] whitespace-nowrap no-underline ${on ? "bg-sunk font-semibold text-ink" : "text-ink2 hover:text-ink"}`;

/** This tab's sections: a sticky column on wide screens (the grid cell spans the content, so it can follow), a scrollable row on phones. */
function SideNav({ sections, active, users }: { sections: Section[]; active: string; users: boolean }) {
  const { t } = useLingui();
  return (
    <div className="md:sticky md:top-0 md:self-start md:pt-1">
      <ScrollArea fadeEdges className="-mx-4 px-4 md:mx-0 md:px-0">
        <nav className="flex gap-1 pb-1 md:flex-col md:pb-0" aria-label={t`Settings sections`}>
          {sections.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={active === id ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                jumpTo(id);
              }}
              className={linkClass(active === id)}
            >
              {t(label)}
              {users && id === "models" && <ModelRetirementDot />}
            </a>
          ))}
          {users && (
            <Link to="/admin/users" className={`${linkClass(false)} md:mt-2 md:border-t md:border-line md:pt-3`}>
              <Trans>Users</Trans> <ArrowUpRight className="h-3.5 w-3.5 text-ink3" aria-hidden />
            </Link>
          )}
        </nav>
      </ScrollArea>
    </div>
  );
}

/** Section id from `#queue` or `#queue&fail=clip:…` (Failed work keeps extra hash params). */
function sectionFromHash(hash = window.location.hash): string {
  const head = (hash.replace(/^#/, "").split("&")[0] ?? "").replace(/=$/, "");
  return head && !head.includes("=") ? head : "";
}

/** Which section is on screen, for the side nav; the hash follows without adding history entries. */
function useActiveSection(ids: readonly string[], landing?: string) {
  const key = ids.join(",");
  const [active, setActive] = useState<string>(() => sectionFromHash() || landing || ids[0]!);
  useEffect(() => {
    setActive(sectionFromHash() || landing || ids[0]!);
    // a click picks the section; the smooth scroll that follows must not hand the highlight to a short section's neighbour
    let pinnedUntil = 0;
    const onHash = () => {
      const id = sectionFromHash();
      if (!ids.includes(id)) return;
      pinnedUntil = Date.now() + 1000;
      setActive(id);
    };
    window.addEventListener("hashchange", onHash);
    // The section under a line a quarter of the way down the scroller is the one being read: the last whose top is
    // above it. Measured over every section on each scroll, looked up then (sections render as their data loads; an
    // IntersectionObserver set up at mount, which only reports the ones that changed, highlighted the wrong one).
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (Date.now() < pinnedUntil) return;
      const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
      const scroller = els[0]?.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
      if (!scroller) return;
      // short sections at the end never reach the line; a click on one pins it (above), and at the end of the page
      // no scroll follows to take it away
      const box = scroller.getBoundingClientRect();
      const line = box.top + box.height * 0.25;
      let pick = els[0];
      for (const el of els) if (el.getBoundingClientRect().top <= line) pick = el;
      if (pick) setActive(pick.id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // capture: the scroller is a ScrollArea viewport further down the tree, and scroll events do not bubble
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("hashchange", onHash);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, landing]);
  return active;
}

/** A deep link (#access, or #queue&fail=…, or /settings/billing) lands on its section once `ready`; extra hash params stay. */
function useLandOnSection(ids: readonly string[], ready: boolean, landing?: string) {
  const loc = useLocation();
  useEffect(() => {
    if (!ready) return;
    const section = sectionFromHash() || landing;
    if (section && ids.includes(section)) scrollToSection(section, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loc.pathname, loc.hash]);
}

/** The on-device model names, as the Overview lists them. */
const ON_DEVICE_MODEL: Record<"text" | "aligner" | "asd" | "vad", MessageDescriptor> = {
  text: msg`text`,
  aligner: msg`alignment`,
  asd: msg`active speaker`,
  vad: msg`vad`,
};

/** "text, alignment on cpu; vad on cpu (always)" or, when a GPU provider was asked for, which models got it. */
function onDeviceSummary(
  d: { requested: string; faces: string | null; text: string | null; vad: string | null; aligner: string | null; asd: string | null },
  t: (m: MessageDescriptor) => string,
) {
  const on = (["text", "aligner", "asd", "vad"] as const).filter((k) => d[k]);
  if (!on.length) return t(msg`all off`);
  const byProvider = new Map<string, string[]>();
  for (const k of on) byProvider.set(d[k]!, [...(byProvider.get(d[k]!) ?? []), t(ON_DEVICE_MODEL[k])]);
  const parts = [...byProvider].map(([provider, ks]) => {
    const models = ks.join(", ");
    return t(msg`${models} on ${provider}`);
  });
  const joined = parts.join("; ");
  const requested = d.requested;
  return requested !== "cpu" && !on.some((k) => d[k] === requested) ? t(msg`${joined} (${requested} unavailable)`) : joined;
}

/**
 * Scroll the page's own ScrollArea so the section's top sits under the 1 rem margin. Not `scrollIntoView`: for a
 * section near the end that cannot reach the top, it also scrolls the overflow-hidden app shell, shifting the whole
 * layout (top bar included) with no scrollbar to bring it back.
 */
function scrollToSection(id: string, smooth: boolean) {
  const el = document.getElementById(id);
  const viewport = el?.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
  if (!el || !viewport) return;
  const top = viewport.scrollTop + el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16;
  viewport.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

function jumpTo(id: string, smooth = true) {
  scrollToSection(id, smooth);
  history.replaceState(null, "", `#${id}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function AccountTab({ hasBilling, hasEmail }: { hasBilling: boolean; hasEmail: boolean }) {
  const loc = useLocation();
  // the billing anchor exists before its lazy chunk does (the fallback holds its place), so a landing can scroll at once
  useLandOnSection(
    accountSections(hasBilling, hasEmail).map(([id]) => id),
    true,
    loc.pathname === BILLING_PATH ? "billing" : undefined,
  );
  return (
    <>
      <div id="profile" className="scroll-mt-4">
        <AccountSection />
      </div>
      <LocaleSection />
      {hasEmail && <EmailSection />}
      {hasBilling && (
        <div id="billing" className="flex scroll-mt-4 flex-col gap-6">
          <Suspense
            fallback={
              <SkeletonRegion className="flex flex-col gap-6">
                <Skeleton className="h-40 w-full rounded-[16px]" />
                <Skeleton className="h-72 w-full rounded-[16px]" />
              </SkeletonRegion>
            }
          >
            <BillingSection />
          </Suspense>
        </div>
      )}
      <div id="defaults" className="scroll-mt-4">
        <ProjectDefaultsSection />
      </div>
      <LearningSection />
      <div id="api-keys" className="scroll-mt-4">
        <ApiKeysSection mcpUrl={`${window.location.origin}/api/mcp`} />
      </div>
      <WebhooksSection />
      <div id="share-links" className="scroll-mt-4">
        <ShareLinksSection />
      </div>
      <div id="connected-apps" className="scroll-mt-4">
        <ConnectedAppsSection />
      </div>
    </>
  );
}

type SystemFacts = {
  storage: string;
  renderConcurrency: { mode: string; max: number };
  limits: { maxCpuPercent: number; minFreeMemMB: number; minFreeDiskMB: number };
  email: string;
  openaiBaseUrl: string | null;
  compatBaseUrl: string | null;
  gpu: { vendor: string; devices: string[] } | null;
  videoEncoder: { name: string; reason: string };
  faceDetection: boolean;
  onDevice: Parameters<typeof onDeviceSummary>[0];
  otel: boolean;
  mcpUrl: string;
  mcpOauth: boolean;
};

/** Facts that come from .env and need a restart to change; shown so an admin knows what this box runs. */
function envFacts(s: SystemFacts, t: (m: MessageDescriptor) => string): (readonly [string, string])[] {
  const max = s.renderConcurrency.max;
  const cpu = s.limits.maxCpuPercent;
  const mem = formatMb(s.limits.minFreeMemMB);
  const disk = formatMb(s.limits.minFreeDiskMB);
  const vendor = s.gpu?.vendor ?? "";
  const devices = s.gpu?.devices.join(", ") || t(msg`device present, no driver tools`);
  const faces = s.onDevice.faces ?? "";
  return [
    [t(msg`Storage`), s.storage],
    [t(msg`Render concurrency`), s.renderConcurrency.mode === "auto" ? t(msg`automatic · up to ${max} per process`) : t(msg`${max} per process (fixed)`)],
    [t(msg`Admission`), t(msg`heavy jobs wait above ${cpu}% CPU, under ${mem} memory or ${disk} disk free`)],
    [t(msg`Email`), s.email],
    [t(msg`OpenAI base URL`), s.openaiBaseUrl ?? "api.openai.com"],
    [t(msg`Compatible base URL`), s.compatBaseUrl ?? t(msg`not set`)],
    [t(msg`GPU (this process)`), s.gpu ? `${vendor}: ${devices}` : t(msg`none visible`)],
    [t(msg`Video encoder`), `${s.videoEncoder.name} · ${s.videoEncoder.reason}`],
    [t(msg`Face detection`), s.faceDetection ? t(msg`on · ${faces}`) : t(msg`off`)],
    [t(msg`On-device models`), onDeviceSummary(s.onDevice, t)],
    [t(msg`OpenTelemetry`), s.otel ? t(msg`on`) : t(msg`off`)],
    [t(msg`MCP endpoint`), s.mcpUrl],
    [t(msg`MCP sign-in`), s.mcpOauth ? t(msg`OAuth or API key`) : t(msg`API key only (MCP_OAUTH is off)`)],
  ];
}

function SystemTab() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.admin.system.queryOptions(), refetchInterval: 15_000 });
  const s = q.data;
  useLandOnSection(
    SYSTEM_SECTIONS.map(([id]) => id),
    !!s,
  );

  const env = s ? envFacts(s, t) : [];

  return (
    <>
      <section id="overview" className="flex scroll-mt-4 flex-col gap-5 rounded-[16px] border border-line bg-panel p-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-[15px] font-bold">
            <Trans>Overview</Trans>
          </h2>
          <UpdateStatusLine version={s ? `${s.version.version} · ${s.version.commit}` : null} />
        </div>
        <UpdateBanner />
        <FleetSummary onJump={jumpTo} />
        <ProcessingTimes />
        <div>
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-bold">
              <Trans>From .env</Trans>
            </h3>
            <span className="text-xs text-ink3">
              <Trans>changes need a restart</Trans>
            </span>
          </div>
          {!s ? (
            <SkeletonRegion label={t`Loading configuration…`} className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              {Array.from({ length: 12 }, (_, i) => (
                <div key={i} className="contents">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className={`h-3.5 justify-self-end ${["w-24", "w-40", "w-16"][i % 3]}`} />
                </div>
              ))}
            </SkeletonRegion>
          ) : (
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
              {env.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink2">{k}</dt>
                  <dd className="truncate text-end font-mono text-xs leading-5" title={v}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </section>

      <WorkersSection />
      <QueueSection />

      <div id="models" className="scroll-mt-4">
        <ModelsSection />
      </div>

      <InstanceSettingsGroup
        id="access"
        title={t`Access`}
        intro={t`Who gets in and what the sign-up form asks for. Applies to the next sign-up or sign-in.`}
        fields={ACCESS_FIELDS}
      />
      <SignupRulesSection />
      <InstanceSettingsGroup
        id="limits"
        title={t`Limits`}
        intro={t`Per-account quotas (0 = unlimited; override one account on the Users page) and what a source may weigh.`}
        fields={LIMIT_FIELDS}
      />
      <InstanceSettingsGroup
        id="pipeline"
        title={t`Pipeline`}
        intro={t`Refine-stage ceilings for every account. Off by default. Turn a gate on so projects (and Project defaults) may opt into that step; leave off to keep every account on the fast path.`}
        fields={PIPELINE_FIELDS}
      />
      <FontsSection />
      <InstanceSettingsGroup
        id="retention"
        title={t`Retention`}
        intro={t`How long files and history stay. Sweeps run every few minutes; a shorter number removes what is already older on the next sweep.`}
        fields={RETENTION_FIELDS}
      />
      <InstanceSettingsGroup
        id="operations"
        title={t`Operations`}
        intro={t`Watchdog, the ready email, update checks and what the health endpoint tells anonymous callers.`}
        fields={OPERATIONS_FIELDS}
      />
      <InstanceSettingsGroup
        id="library"
        title={t`Library`}
        intro={t`Where Browse finds sounds, icons and media. The Reelsaw catalog and Iconify need nothing; paste a free key to switch a provider on. Keys are stored encrypted and never shown again.`}
        fields={LIBRARY_FIELDS}
      />

      <div id="log-level" className="scroll-mt-4">
        <LogLevelSection />
      </div>
    </>
  );
}
