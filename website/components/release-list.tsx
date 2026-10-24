import { formatUtcDate, type Release, type ReleaseNote } from "@/lib/releases-data";
import { SITE } from "@/lib/site";

export function utcDate(iso: string) {
  return formatUtcDate(iso);
}

export function ReleaseArticle({ release: r, current }: { release: Release; current?: string | null }) {
  const you = current && (current === r.version || current === r.tag);
  return (
    <article id={r.tag} className="scroll-mt-24 border-t border-line pt-6">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h2 className="font-mono text-[22px] font-bold tracking-tight">
          <a href={`#${r.tag}`} className="text-ink no-underline hover:text-acc-text">
            {r.version}
          </a>
        </h2>
        <time dateTime={r.publishedAt} className="text-sm text-ink3">
          {utcDate(r.publishedAt)}
        </time>
        {r.prerelease && <span className="chip bg-warn-soft text-warn">Pre-release</span>}
        {you && <span className="chip bg-acc-soft text-acc-text">This install</span>}
        <a href={r.url} target="_blank" rel="noreferrer" className="ml-auto text-xs text-ink3 hover:text-acc-text">
          GitHub ↗
        </a>
      </header>
      {r.notes.length ? (
        <ul className="mt-4 flex flex-col gap-2.5">
          {r.notes.map((n, i) => (
            <li key={`${n.sha ?? n.pr ?? i}-${n.text.slice(0, 24)}`} className="text-sm leading-relaxed text-ink2">
              <NoteText note={n} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-ink2">{r.summary || r.name}</p>
      )}
    </article>
  );
}

function NoteText({ note }: { note: ReleaseNote }) {
  return (
    <>
      {note.pr ? (
        <>
          <a href={`${SITE.github}/pull/${note.pr}`} target="_blank" rel="noreferrer" className="prose-link font-mono text-[12px]">
            #{note.pr}
          </a>{" "}
        </>
      ) : null}
      {note.sha ? (
        <>
          <a href={`${SITE.github}/commit/${note.sha}`} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-ink3 hover:text-acc-text">
            {note.sha.slice(0, 7)}
          </a>{" "}
        </>
      ) : null}
      {note.text}
    </>
  );
}
