import { ChevronRight } from "lucide-react";
import type { Faq, Link, Table } from "@/content/types";
import { SITE } from "@/lib/site";
import { ScrollArea } from "./scroll-area";

export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

/** Visible breadcrumb trail plus BreadcrumbList structured data. Each crumb is {href, label}; the last is the current page. */
export function Breadcrumbs({ items }: { items: Link[] }) {
  const data = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.label, item: `${SITE.url}${it.href}` })),
  };
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-ink3">
      <JsonLd data={data} />
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((it, i) => (
          <li key={it.href} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden />}
            {i < items.length - 1 ? (
              <a href={it.href} className="hover:text-ink">
                {it.label}
              </a>
            ) : (
              <span aria-current="page" className="text-ink2">
                {it.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function FaqSection({ faqs, heading = "Common questions" }: { faqs: Faq[]; heading?: string }) {
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <section aria-labelledby="faq-title" className="flex flex-col gap-5">
      <JsonLd data={data} />
      <h2 id="faq-title" className="text-[24px] font-bold tracking-tight">
        {heading}
      </h2>
      <dl className="grid gap-3">
        {faqs.map((f) => (
          <div key={f.q} className="card p-5">
            <dt className="text-[15px] font-bold">
              <h3>{f.q}</h3>
            </dt>
            <dd className="mt-2 text-sm leading-relaxed text-ink2">{f.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function DataTable({ table, caption }: { table: Table; caption?: string }) {
  return (
    <ScrollArea className="card">
      <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line bg-sunk/60 text-left">
            {table.columns.map((c, i) => (
              <th key={i} scope="col" className={`px-4 py-2.5 text-xs font-semibold tracking-wide text-ink2 uppercase ${i === 0 ? "w-[26%]" : ""}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-b border-line align-top last:border-b-0">
              {r.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row" className="px-4 py-3 text-left font-semibold text-ink">
                    {cell}
                  </th>
                ) : (
                  <td key={j} className="px-4 py-3 leading-relaxed text-ink2">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

export function LinkList({ heading, links, external = false }: { heading: string; links: Link[]; external?: boolean }) {
  return (
    <section className="flex flex-col gap-3" aria-label={heading}>
      <h2 className="text-[18px] font-bold tracking-tight">{heading}</h2>
      <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
        {links.map((l) => (
          <li key={l.href + l.label}>
            <a href={l.href} className="prose-link" {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TryIt() {
  return (
    <aside className="card flex flex-col items-start gap-3 bg-acc-soft/40 p-6 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-[16px] font-bold">Try it: paste a link, get vertical clips</p>
        <p className="mt-1 text-sm text-ink2">One command installs Reelsaw with Docker: no plan, no meter, no watermark.{SITE.hosted ? " Or start on the hosted Free plan." : ""}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <a href="/#install" className="btn-primary">
          Install Reelsaw
        </a>
        <a href={SITE.github} target="_blank" rel="noreferrer" className="btn-ghost">
          Source on GitHub
        </a>
      </div>
    </aside>
  );
}

export function ArticleHeader({ crumbs, eyebrow, h1, intro, checked }: { crumbs: Link[]; eyebrow: string; h1: string; intro: string[]; checked?: string }) {
  return (
    <header className="flex flex-col gap-5">
      <Breadcrumbs items={crumbs} />
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="text-[32px] leading-[1.1] font-extrabold tracking-tight text-balance sm:text-[44px]">{h1}</h1>
      <div className="flex max-w-[70ch] flex-col gap-3 text-[16px] leading-relaxed text-ink2 text-pretty">
        {intro.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {checked && (
        <p className="text-xs text-ink3">
          Pricing checked {checked} on each vendor's public page. Vendors change plans without notice; verify before you buy.
        </p>
      )}
    </header>
  );
}
