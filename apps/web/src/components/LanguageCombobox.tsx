import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { languageLabel, spokenLanguageCode, spokenLanguageOptions, WHISPER_SPOKEN_LANGUAGES } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { Combobox } from "./ui";

const DETECT = "";

/**
 * The spoken-language picker (project defaults, new project): the languages the transcription model
 * takes (`languages.list`; Whisper's until the server answers), by name, plus "Detect automatically". `value` is a code or "" (detect); a saved value from before the picker
 * ("English", "pt-BR") is shown as its code's name, and a code outside the list stays selectable.
 * Under it, what works less well for the chosen language than for English (the server's language registry, the
 * same list `list_languages` and `reelsaw languages` give), so the gap is seen before anything renders.
 */
export function LanguageCombobox({
  value,
  onValueChange,
  className = "",
  size,
}: {
  value: string | undefined;
  onValueChange: (code: string | undefined) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  const { t } = useLingui();
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.languages.list.queryOptions(), staleTime: 5 * 60_000 });
  const codes = useMemo(() => q.data?.languages.map((l) => l.code) ?? WHISPER_SPOKEN_LANGUAGES, [q.data]);
  const code = spokenLanguageCode(value) ?? DETECT;
  const gapsOf = useMemo(() => new Map((q.data?.languages ?? []).map((l) => [l.code, l.gaps])), [q.data]);
  const options = useMemo(() => {
    const list = spokenLanguageOptions(codes).map(({ native, ...o }) => {
      // a language that cannot show its captions on this server says so in the list itself
      const noCaptions = gapsOf.get(o.value)?.some((g) => g.stage === "captionFont" && g.level === "none");
      const hint = [native, noCaptions ? t`no caption font` : ""].filter(Boolean).join(" · ");
      return { ...o, ...(hint ? { hint } : {}), ...(native ? { keywords: [native] } : {}) };
    });
    const known = code === DETECT || list.some((o) => o.value === code);
    return [{ value: DETECT, label: t`Detect automatically` }, ...(known ? [] : [{ value: code, label: languageLabel(code) }]), ...list];
  }, [code, codes, gapsOf, t]);
  const gaps = code === DETECT ? [] : (gapsOf.get(code) ?? []);
  const codeLabel = languageLabel(code);
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <Combobox
        ariaLabel={t`Spoken language`}
        value={code}
        onValueChange={(v) => onValueChange(v === DETECT ? undefined : v)}
        options={options}
        placeholder={t`Detect automatically`}
        emptyText={t`No such language`}
        {...(size ? { size } : {})}
      />
      {gaps.length > 0 && (
        <ul className="m-0 list-none p-0 text-xs leading-snug text-ink3" aria-label={t`What works less well for ${codeLabel}`}>
          {gaps.map((g) => (
            <li key={g.stage} className={g.level === "none" && g.stage === "captionFont" ? "text-warn" : undefined}>
              <span className="font-medium text-ink2">{g.label[0]!.toUpperCase() + g.label.slice(1)}:</span> {g.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
