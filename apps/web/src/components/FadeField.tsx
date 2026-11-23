import { msg, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { FADE_PRESETS, formatNumber } from "@reelsaw/shared";
import { Segmented } from "./ui";

/** "0.6 s" for a fade length; "Off" at 0. */
export const fadeText = (sec: number) => (sec > 0 ? `${formatNumber(Number(sec.toFixed(2)))} s` : t`Off`);

/** The built-in presets' names (FADE_PRESETS in @reelsaw/shared), by their English label. */
const PRESET_LABELS: Record<string, MessageDescriptor> = {
  Off: msg`Off`,
  Quick: msg`Quick`,
  Smooth: msg`Smooth`,
  Slow: msg`Slow`,
};

/**
 * A fade length as Off / Quick / Smooth / Slow. A length set elsewhere (MCP, the CLI) that is not one of these
 * selects none of them; the label row's seconds still say what it is, so nothing is hidden.
 */
export function FadePresets({
  value,
  onChange,
  ariaLabel,
  disabled,
  offLabel,
  presets = FADE_PRESETS,
}: {
  value: number;
  onChange: (sec: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  offLabel?: string;
  presets?: ReadonlyArray<{ sec: number; label: string }>;
}) {
  const { t: tr, i18n } = useLingui();
  const match = presets.find((p) => Math.abs(p.sec - value) < 0.026);
  const builtIn = presets === FADE_PRESETS;
  const labelOf = (p: { sec: number; label: string }) => {
    if (p.sec === 0) return offLabel ?? tr`Off`;
    const known = builtIn ? PRESET_LABELS[p.label] : undefined;
    return known ? i18n._(known) : p.label;
  };
  return (
    <Segmented
      size="sm"
      ariaLabel={ariaLabel}
      disabled={disabled}
      value={match ? match.sec : -1}
      onChange={onChange}
      options={presets.map((p) => ({ value: p.sec, label: labelOf(p), ...(p.sec ? { title: `${formatNumber(p.sec)} s` } : {}) }))}
    />
  );
}
