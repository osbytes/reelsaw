import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { useTRPC } from "../lib/trpc";
import { TemplateEditor } from "../components/TemplateEditor";
import { ClipEditorSkeleton } from "../components/PageSkeletons";

/** Full-screen template editor route: /templates/:id (docs/specs/layer-templates.md). */
export function TemplateEditorPage() {
  const { id = "" } = useParams();
  const trpc = useTRPC();
  const nav = useNavigate();
  // the editor owns the document once open: a background refetch must not reset it
  const q = useQuery({ ...trpc.layerTemplates.get.queryOptions({ id }), refetchOnWindowFocus: false });
  if (q.isPending) return <ClipEditorSkeleton />;
  if (!q.data || q.data.deletedAt) {
    const missing = !q.error || q.error.data?.code === "NOT_FOUND" || !!q.data?.deletedAt;
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center px-5 py-16">
        <div role={missing ? undefined : "alert"} className="flex w-full max-w-[460px] flex-col items-center gap-3 text-center">
          <span className="font-mono text-2xl leading-8 text-ink3" aria-hidden>
            {missing ? "∅" : "▲"}
          </span>
          <b className="text-lg">{missing ? "This template doesn’t exist" : "Couldn’t load this template"}</b>
          <p className="text-[13px] leading-relaxed text-ink2">{missing ? "It may have been deleted (you can restore it from Deleted), or it belongs to another account." : q.error?.message}</p>
          <div className="mt-1 flex gap-2">
            <Link to="/templates" className="btn-primary py-2 no-underline">
              Back to templates
            </Link>
            {!missing && (
              <button className="btn-ghost py-2" onClick={() => q.refetch()}>
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  return <TemplateEditor key={q.data.id} template={q.data} onExit={() => nav(`/templates#template=${q.data.id}`)} />;
}
