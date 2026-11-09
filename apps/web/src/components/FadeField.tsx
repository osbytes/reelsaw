import { FADE_PRESETS } from "@reelsaw/shared";
import { Segmented } from "./ui";

/** "0.6 s" for a fade length; "Off" at 0. */
export const fadeText = (sec: number) => (sec > 0 ? `${Number(sec.toFixed(2))} s` : "Off");

/**
 * A fade length as Off / Quick / Smooth / Slow. A length set elsewhere (MCP, the CLI) that is not one of these
 * selects none of them; the label row's seconds still say what it is, so nothing is hidden.
 */
export function FadePresets({
  value,
  onChange,
  ariaLabel,
  disabled,
  offLabel = "Off",
  presets = FADE_PRESETS,
}: {
  value: number;
  onChange: (sec: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  offLabel?: string;
  presets?: ReadonlyArray<{ sec: number; label: string }>;
}) {
  const match = presets.find((p) => Math.abs(p.sec - value) < 0.026);
  return (
    <Segmented
      size="sm"
      ariaLabel={ariaLabel}
      disabled={disabled}
      value={match ? match.sec : -1}
      onChange={onChange}
      options={presets.map((p) => ({ value: p.sec, label: p.sec === 0 ? offLabel : p.label, ...(p.sec ? { title: `${p.sec} s` } : {}) }))}
    />
  );
}
