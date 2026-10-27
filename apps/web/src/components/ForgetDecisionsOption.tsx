/**
 * "Also forget what Reelsaw learned from it": the decision-log choice offered wherever a project is deleted
 * (docs/specs/decision-log.md). On a soft delete it takes effect at the purge, Delete forever or the retention sweep,
 * whichever comes first; a restore cancels it.
 */
export function ForgetDecisionsOption({ checked, onChange, later }: { checked: boolean; onChange: (v: boolean) => void; later?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--acc)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm">Also forget what Reelsaw learned from it</span>
        <span className="block text-xs text-ink3">
          {later
            ? "Your accepted and rejected fixes and clip edits are kept so Reelsaw keeps learning, unless you tick this. They are forgotten when it is deleted forever (by you or automatically); restoring it keeps them."
            : "Your accepted and rejected fixes and clip edits are kept so Reelsaw keeps learning, unless you tick this."}
        </span>
      </span>
    </label>
  );
}
