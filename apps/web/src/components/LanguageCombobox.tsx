import { useMemo } from "react";
import { languageLabel, spokenLanguageCode, spokenLanguageOptions } from "@reelsaw/shared";
import { Combobox } from "./ui";

const DETECT = "";

/**
 * The spoken-language picker (project defaults, new project): Whisper's languages by name, plus
 * "Detect automatically". `value` is a code or "" (detect); a saved value from before the picker
 * ("English", "pt-BR") is shown as its code's name, and a code outside the list stays selectable.
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
  const code = spokenLanguageCode(value) ?? DETECT;
  const options = useMemo(() => {
    const list = spokenLanguageOptions().map(({ native, ...o }) => (native ? { ...o, hint: native, keywords: [native] } : o));
    const known = code === DETECT || list.some((o) => o.value === code);
    return [{ value: DETECT, label: "Detect automatically" }, ...(known ? [] : [{ value: code, label: languageLabel(code) }]), ...list];
  }, [code]);
  return (
    <Combobox
      ariaLabel="Spoken language"
      value={code}
      onValueChange={(v) => onValueChange(v === DETECT ? undefined : v)}
      options={options}
      placeholder="Detect automatically"
      emptyText="No such language"
      className={className}
      {...(size ? { size } : {})}
    />
  );
}
