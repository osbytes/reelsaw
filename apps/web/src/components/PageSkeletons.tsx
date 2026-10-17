import { Skeleton, SkeletonRegion } from "./ui";

const W = ["w-11/12", "w-4/5", "w-full", "w-2/3", "w-5/6", "w-3/4"];

/** A clip card in the project's clips column (poster box plus title, status and a button row). */
function ClipCardSkeleton({ i }: { i: number }) {
  return (
    <div className="flex gap-3 rounded-[14px] border border-line bg-panel p-3">
      <Skeleton className="aspect-[9/16] w-[84px] shrink-0 rounded-[8px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className={`h-4 ${["w-4/5", "w-2/3", "w-11/12"][i % 3]}`} />
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/5" />
        <div className="mt-auto flex gap-1.5">
          <Skeleton className="h-7 w-16 rounded-[8px]" />
          <Skeleton className="h-7 w-16 rounded-[8px]" />
        </div>
      </div>
    </div>
  );
}

/** The project page while it loads: header, source player strip, transcript lines and the clips column. */
export function ProjectPageSkeleton({ compact, width }: { compact: boolean; width: number }) {
  const header = (
    <div className={`flex shrink-0 items-center border-b border-line px-4 sm:px-5 ${compact ? "gap-3 py-2.5" : "gap-5 py-3.5"}`}>
      <div className="min-w-0 flex-1">
        {!compact && <Skeleton className="h-4 w-40" />}
        <Skeleton className={`mt-1 ${compact ? "h-5 w-3/4" : "h-6 w-1/2"}`} />
        <div className="mt-2 flex gap-3.5">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-24 rounded-[10px]" />
        <Skeleton className="h-9 w-10 rounded-[10px]" />
      </div>
    </div>
  );
  const transcript = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 border-t border-line px-5 py-5">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex gap-2.5">
          <Skeleton className="h-4 w-10 shrink-0" />
          <Skeleton className={`h-4 ${W[i % W.length]}`} />
        </div>
      ))}
    </div>
  );
  const clips = (
    <div className="flex flex-col gap-3 p-3">
      {Array.from({ length: 3 }, (_, i) => (
        <ClipCardSkeleton key={i} i={i} />
      ))}
    </div>
  );
  const source = (
    <div className="flex gap-4 px-4 py-3 sm:px-5">
      <Skeleton className="aspect-video w-[200px] shrink-0 rounded-[10px]" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2.5">
        <div className="flex gap-1.5">
          <Skeleton className="h-7 w-12 rounded-[8px]" />
          <Skeleton className="h-7 w-16 rounded-[8px]" />
          <Skeleton className="h-7 w-12 rounded-[8px]" />
        </div>
        <Skeleton className="h-1 w-full rounded-full" />
      </div>
    </div>
  );
  return (
    <SkeletonRegion label="Loading project…" className="flex min-h-0 flex-1 flex-col">
      {header}
      {compact ? (
        <>
          {source}
          {transcript}
        </>
      ) : (
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `minmax(0,1fr) ${width < 1100 ? 320 : width < 1280 ? 360 : 400}px` }}>
          <section className="flex min-h-0 min-w-0 flex-col">
            {source}
            {transcript}
          </section>
          <aside className="border-l border-line bg-sunk">{clips}</aside>
        </div>
      )}
    </SkeletonRegion>
  );
}

/** The clip editor while it loads: video box, timeline bar and the side panel's rows. */
export function ClipEditorSkeleton() {
  return (
    <SkeletonRegion label="Loading clip…" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <Skeleton className="h-8 w-8 rounded-[8px]" />
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="ml-auto h-9 w-24 rounded-[10px]" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col items-center gap-4 p-4">
          <Skeleton className="aspect-[9/16] max-h-[60vh] w-full max-w-[340px] rounded-[14px]" />
          <Skeleton className="h-10 w-full max-w-[720px] rounded-[8px]" />
        </div>
        <div className="flex w-full flex-col gap-4 border-t border-line p-4 lg:w-[360px] lg:border-l lg:border-t-0">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className={`h-9 ${["w-full", "w-full", "w-11/12", "w-full", "w-4/5"][i]} rounded-[8px]`} />
            </div>
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}
