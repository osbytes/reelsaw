import { msg } from "@lingui/core/runtime-macro";
import { rich, t } from "@/lib/i18n";
// A long stream's Most replayed heatmap with the stretches Reelsaw took from it: the whole video is the width, the
// heat is YouTube's own, the marked bands are the peaks check_source returned and create_project planned, and the
// bar underneath is the share of the video that was fetched, transcribed and counted. Static: no script.

import Image from "next/image";
import type { ReactNode } from "react";
import streamPoster from "@/public/clips/stream.jpg";
import { REPLAY, fmtTime } from "@/content/demo";

const W = 1000;
const H = 120;
const TOP = 22;

/** 8956 → "2:29:16" */
const fmtLong = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}` : fmtTime(s);

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-sunk px-1 py-0.5 font-mono text-[13px] whitespace-nowrap text-ink">{children}</code>;
}

export function ReplayRanges() {
  const { source, heat, peaks, billedSec } = REPLAY;
  const x = (sec: number) => (sec / source.seconds) * W;
  const bin = W / heat.length;
  const y = (v: number) => H - v * (H - TOP);
  // a step area: each bin is flat across its own width, as YouTube draws it
  const area = `M0 ${H} ${heat.map((v, i) => `L${i * bin} ${y(v)} L${(i + 1) * bin} ${y(v)}`).join(" ")} L${W} ${H} Z`;
  const billedMin = Math.round((billedSec / 60) * 10) / 10;
  const totalMin = Math.round(source.seconds / 60);
  const share = billedSec / source.seconds;

  return (
    <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-12">
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-3 gap-3">
          <div className="card flex flex-col gap-1 p-3.5">
            <dt className="text-xs text-ink3">{t(msg`Stream`)}</dt>
            <dd className="font-mono text-[20px] font-bold tracking-tight">{fmtLong(source.seconds)}</dd>
          </div>
          <div className="card flex flex-col gap-1 p-3.5">
            <dt className="text-xs text-ink3">{t(msg`Peaks taken`)}</dt>
            <dd className="font-mono text-[20px] font-bold tracking-tight">{peaks.length}</dd>
          </div>
          <div className="card flex flex-col gap-1 border-acc p-3.5">
            <dt className="text-xs text-ink3">{t(msg`Minutes counted`)}</dt>
            <dd className="font-mono text-[20px] font-bold tracking-tight text-acc-text">{billedMin}</dd>
          </div>
        </dl>
        <p className="text-[15px] leading-relaxed text-ink2 text-pretty">
          {rich(
            msg`On the New project page the peaks are chips over the video's timeline, one click each; an agent passes <0>rangesFrom</0> to <1>create_project</1>, and the CLI takes <2>--most-replayed</2>. Reelsaw then picks the moments inside each peak, so a clip starts where a sentence does, not where the graph does.`,
            { 0: (c) => <Code>{c}</Code>, 1: (c) => <Code>{c}</Code>, 2: (c) => <Code>{c}</Code> },
          )}
        </p>
        <p className="text-[15px] leading-relaxed text-ink2 text-pretty">
          {rich(
            msg`No heatmap, or you know the part you want? Drag your own ranges on the timeline, or send them: <0>--range 1:15:00-1:30:00</0>. A range can find clips inside it, or be the clip.`,
            {
              0: (c) => <Code>{c}</Code>,
            },
          )}
        </p>
      </div>

      <figure className="card flex min-w-0 flex-col gap-4 p-4 shadow-pop sm:p-5">
        <div className="flex items-center gap-3">
          <Image src={streamPoster} alt="" sizes="128px" className="aspect-video w-24 shrink-0 rounded-[8px] object-cover sm:w-32" />
          <div className="min-w-0">
            <a href={source.url} target="_blank" rel="noreferrer" className="prose-link block truncate text-sm font-semibold">
              {source.title}
            </a>
            <p className="text-xs text-ink3">
              {t(msg`by ${{ author: source.author }}, CC BY`)} · {fmtLong(source.seconds)}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-ink2">{t(msg`YouTube's Most replayed, across the whole stream`)}</p>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="block h-[96px] w-full sm:h-[120px]"
            role="img"
            aria-label={t(msg`Replay heatmap of the ${{ length: fmtLong(source.seconds) }} stream, with the ${{ n: peaks.length }} hottest stretches marked`)}
          >
            {peaks.map((p) => (
              <rect key={p.rank} x={x(p.start)} y={0} width={Math.max(x(p.end) - x(p.start), 4)} height={H} className="fill-acc-soft" />
            ))}
            <path d={area} className="fill-line2" />
            {/* the heat inside each taken stretch, in the accent */}
            <defs>
              {peaks.map((p) => (
                <clipPath key={p.rank} id={`peak-${p.rank}`}>
                  <rect x={x(p.start)} y={0} width={Math.max(x(p.end) - x(p.start), 4)} height={H} />
                </clipPath>
              ))}
            </defs>
            {peaks.map((p) => (
              <path key={p.rank} d={area} clipPath={`url(#peak-${p.rank})`} className="fill-acc" />
            ))}
          </svg>
          {/* rank labels sit under their band, in HTML so they keep their size when the chart stretches; on a phone
              the close peaks would overlap, so the bands speak for themselves there */}
          <div className="relative hidden h-4 sm:block" aria-hidden>
            {peaks.map((p) => (
              <span
                key={p.rank}
                className="absolute -translate-x-1/2 font-mono text-[10px] font-semibold text-acc-text"
                style={{ left: `${((p.start + p.end) / 2 / source.seconds) * 100}%` }}
              >
                #{p.rank}
              </span>
            ))}
          </div>
          <div className="flex justify-between font-mono text-[10px] text-ink3" aria-hidden>
            <span>0:00</span>
            <span>{fmtLong(source.seconds / 2)}</span>
            <span>{fmtLong(source.seconds)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-semibold text-ink2">{t(msg`Downloaded, transcribed and counted`)}</span>
            <span className="font-mono text-ink3">{t(msg`${{ billed: billedMin }} of ${{ total: totalMin }} min`)}</span>
          </div>
          <div className="relative h-2.5 overflow-hidden rounded-full bg-sunk ring-1 ring-line" aria-hidden>
            {peaks.map((p) => (
              <span
                key={p.rank}
                className="absolute inset-y-0 bg-acc"
                style={{ left: `${(p.start / source.seconds) * 100}%`, width: `max(3px, ${((p.end - p.start) / source.seconds) * 100}%)` }}
              />
            ))}
          </div>
          <p className="text-xs text-ink3">
            {t(
              msg`${{ pct: Math.round(share * 1000) / 10 }}% of the stream. The other ${{ rest: Math.round(totalMin - billedMin) }} minutes are never downloaded.`,
            )}
          </p>
        </div>
      </figure>
    </div>
  );
}
