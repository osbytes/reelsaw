import { CopyButton } from "./copy-button";

/** A one-line shell command in a panel with a copy button. */
export function Command({ text, lang = "bash", caption }: { text: string; lang?: string; caption?: string }) {
  return (
    <figure className="card min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-sunk/60 px-3 py-1.5">
        <figcaption className="truncate font-mono text-[11px] text-ink3">{caption ?? lang}</figcaption>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[13px] leading-relaxed text-ink">
        <code className={`language-${lang}`}>{text}</code>
      </pre>
    </figure>
  );
}

/** A multi-line code block (no copy button). */
export function Code({ children, lang = "bash" }: { children: string; lang?: string }) {
  return (
    <pre className="card min-w-0 overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-relaxed text-ink2">
      <code className={`language-${lang}`}>{children}</code>
    </pre>
  );
}
