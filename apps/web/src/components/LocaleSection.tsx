import { Trans, useLingui } from "@lingui/react/macro";
import { isLocale, type LocalePrefsPatch, SHIPPED_LOCALES } from "@reelsaw/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { activeLocale, applyAccountLocale, chooseLocale } from "../lib/i18n";
import { useTRPC } from "../lib/trpc";
import { Combobox, Select } from "./ui";

const FOLLOW = "";

/** A locale's own name ("English", "Deutsch"), for the language picker. */
function localeName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The runtime's zones plus UTC (Chrome lists only region zones) and a saved alias it does not list ("Asia/Calcutta"). */
function timeZones(saved: string | null | undefined): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // an older runtime: UTC and the saved one only
  }
  return [...new Set(["UTC", ...(saved ? [saved] : []), ...zones])];
}

/** Applies the account's saved language once it is known (lib/i18n.ts chain). Mounted once, in App. */
export function AccountLocale() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.me.localePrefs.queryOptions(), staleTime: 5 * 60_000, retry: false });
  useEffect(() => applyAccountLocale(q.data?.locale), [q.data?.locale]);
  return null;
}

/**
 * Settings → Account → Language and region (apps/server/src/notify/locale.ts): the language of the app, emails,
 * notices and messages, and the time zone the days in mail are read in. Same service as MCP
 * `set_locale_preferences` and `reelsaw locale-prefs`.
 */
export function LocaleSection() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery(trpc.me.localePrefs.queryOptions());
  const save = useMutation(
    trpc.me.updateLocalePrefs.mutationOptions({
      onSuccess: (r, patch: LocalePrefsPatch) => {
        if (patch.locale !== undefined) chooseLocale(r.locale);
        toast(t`Saved`);
        void qc.invalidateQueries({ queryKey: trpc.me.localePrefs.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneOptions = useMemo(
    () => [
      { value: FOLLOW, label: t`This browser's (${browserZone}); UTC in email` },
      ...timeZones(q.data?.timeZone).map((z) => ({ value: z, label: z.replaceAll("_", " ") })),
    ],
    [t, browserZone, q.data?.timeZone],
  );
  const languageOptions = [
    { value: FOLLOW, label: t`Follow the browser` },
    ...SHIPPED_LOCALES.map((l) => ({ value: l, label: localeName(l) })),
    // the pseudo-locale stays choosable once picked (`?locale=en-XA`), for checking a screen
    ...(activeLocale() === "en-XA" ? [{ value: "en-XA", label: t`Pseudo-locale (en-XA)` }] : []),
  ];
  const locale = save.isPending && save.variables.locale !== undefined ? save.variables.locale : q.data?.locale;
  const zone = save.isPending && save.variables.timeZone !== undefined ? save.variables.timeZone : q.data?.timeZone;

  return (
    <section id="language" className="flex scroll-mt-4 flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">
        <Trans>Language and region</Trans>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5 text-sm">
          <span className="font-semibold">
            <Trans>Language</Trans>
          </span>
          <Select
            ariaLabel={t`Language`}
            value={locale ?? FOLLOW}
            options={languageOptions}
            disabled={q.isPending || save.isPending}
            onValueChange={(v) => save.mutate({ locale: isLocale(v) ? v : null })}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 text-sm">
          <span className="font-semibold">
            <Trans>Time zone</Trans>
          </span>
          <Combobox
            ariaLabel={t`Time zone`}
            value={zone ?? FOLLOW}
            options={zoneOptions}
            placeholder={t`Choose…`}
            emptyText={t`No such time zone`}
            onValueChange={(v) => save.mutate({ timeZone: v === FOLLOW ? null : v })}
          />
        </div>
      </div>
      <span className="text-[13px] text-ink2">
        <Trans>The app, emails, notices and messages to your agents use this language. Dates in email are read in this time zone.</Trans>
      </span>
    </section>
  );
}
