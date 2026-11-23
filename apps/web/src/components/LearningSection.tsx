import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { ConfirmDialog, Skeleton } from "./ui";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

/** Settings → Account: whether Reelsaw records your accept/reject/edit decisions, what it holds, and a way to forget it. */
export function LearningSection() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const summary = useQuery(trpc.decisions.summary.queryOptions());
  const [confirming, setConfirming] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: trpc.decisions.summary.queryKey() });
  const setLearning = useMutation(trpc.decisions.setLearning.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const forget = useMutation(trpc.decisions.forget.mutationOptions());
  const d = summary.data;
  // show the pending choice immediately; the query catches up on success
  const enabled = setLearning.isPending ? setLearning.variables.enabled : (d?.enabled ?? false);

  return (
    <section id="learning" className="flex scroll-mt-4 flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div>
        <h2 className="text-[15px] font-bold">
          <Trans>Learning</Trans>
        </h2>
        <p className="mt-1 text-[13px] text-ink2">
          <Trans>
            Reelsaw records what you accept, reject, cut, correct and edit, and uses it (for example, cuts you rejected are shown to the filler detector as
            examples to keep). It stays on this instance and outlives deleted projects. Turning it off stops recording; what is kept stays.
          </Trans>
        </p>
      </div>
      <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
        <span>
          <Trans>Learn from my decisions</Trans>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={!d || setLearning.isPending}
          onClick={() => setLearning.mutate({ enabled: !enabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${enabled ? "bg-acc" : "bg-line2"}`}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${enabled ? "start-[18px]" : "start-0.5"}`} />
        </button>
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="min-h-5 text-[13px] text-ink2">{d ? <DecisionCount total={d.total} projects={d.projects} /> : <Skeleton className="h-4 w-48" />}</div>
        <button className="btn-danger" disabled={!d || d.total === 0} onClick={() => setConfirming(true)}>
          <Trans>Forget everything</Trans>
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t`Forget everything?`}
        body={t`Every decision Reelsaw recorded from you, across all projects, is deleted. It can’t be undone, and Reelsaw starts learning from scratch.`}
        confirm={t`Forget everything`}
        danger
        onConfirm={() =>
          forget.mutateAsync({}).then((r) => {
            refresh();
            toast(r.message);
          })
        }
      />
    </section>
  );
}

/** "12 decisions from 3 projects": each count with its own plural. */
function DecisionCount({ total, projects }: { total: number; projects: number }) {
  const decisions = plural(total, { one: "# decision", other: "# decisions" });
  const from = plural(projects, { one: "# project", other: "# projects" });
  return (
    <Trans>
      {decisions} from {from}
    </Trans>
  );
}
