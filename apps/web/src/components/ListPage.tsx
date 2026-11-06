import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ScrollArea } from "./scroll-area";

/**
 * The one shape of a full-page list (Templates, Users, Deleted): page frame and header, a fixed-layout
 * table in a card, the empty state, and a footer with the count. docs/PRINCIPLES.md ("Lists align") has
 * the rules; they are encoded here so a new list cannot drift from them.
 *
 * Every list folds at the same width: below 1040px a `full` column disappears, its content goes on a line
 * inside the name cell, and every action moves into the ⋯ menu.
 */

/** A row's title, in the name cell. */
export const LIST_TITLE = "truncate text-[14px] font-semibold text-ink";
/** A line under the title. */
export const LIST_SUB = "truncate text-xs text-ink3";
/** An inline action, next to the ⋯ menu; the caller adds its button style and width. Hidden below the fold width, where the menu has it. */
export const LIST_ACTION = "hidden h-8 justify-center text-xs no-underline min-[1040px]:inline-flex";
/** The same action as a ⋯ menu item, only below the fold width. */
export const LIST_MENU_ITEM_FOLDED = "menu-item min-[1040px]:hidden";
export const LIST_MENU = "menu w-[230px]";
/** The actions column: one inline action and the ⋯ menu, or only the menu below the fold width. */
export const LIST_ACTIONS_WIDTH = "w-14 min-[1040px]:w-[9.5rem]";
/** How many rows a list shows while it loads. */
export const LIST_SKELETON_ROWS = 5;

const FULL = "hidden min-[1040px]:table-cell";
const FULL_COL = "hidden min-[1040px]:table-column";

export type ListColumn = {
  label: ReactNode;
  /** Names a column whose header shows nothing. */
  srLabel?: string;
  /** Literal Tailwind width classes; omit on the one column that flexes. */
  width?: string;
  /** Only from 1040px up. */
  full?: boolean;
  right?: boolean;
  /** Makes the header a sort button. */
  sort?: { dir: 1 | -1 | null; onToggle: () => void; title?: string };
  className?: string;
};

export function ListPage({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold tracking-tight">{title}</h1>
            {/* height reserved so the list does not move when the line fills in */}
            <p className="mt-1 min-h-5 text-sm text-ink2">{subtitle}</p>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </main>
    </ScrollArea>
  );
}

export function ListEmpty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-line2 px-5 py-10 text-center">
      <Icon className="h-6 w-6 text-ink3" aria-hidden />
      <b className="text-[15px]">{title}</b>
      {children && <p className="max-w-[440px] text-[13px] leading-relaxed text-ink2">{children}</p>}
    </div>
  );
}

export function ListError({ message }: { message: string }) {
  return <p className="text-[13px] text-err">✕ {message}</p>;
}

/**
 * The card clips with `overflow-clip`, not `overflow-hidden`: it rounds the rows' corners without becoming
 * a scroll container, so the sticky header still sticks to the page's ScrollArea.
 */
export function ListTable({
  caption,
  columns,
  loading,
  loadingLabel,
  children,
}: {
  caption: string;
  columns: ListColumn[];
  loading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={loading ? "status" : undefined}
      aria-busy={loading || undefined}
      className="overflow-clip rounded-[16px] border border-line bg-panel text-[13px]"
    >
      {loading && <span className="sr-only">{loadingLabel ?? "Loading…"}</span>}
      <table className="w-full table-fixed border-separate border-spacing-0">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          {columns.map((c, i) => (
            <col key={i} className={`${c.full ? FULL_COL : ""} ${c.width ?? ""}`} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                scope="col"
                aria-sort={c.sort?.dir ? (c.sort.dir === 1 ? "ascending" : "descending") : undefined}
                className={`sticky top-0 z-10 h-9 border-b border-line bg-panel px-3 align-middle text-xs font-medium leading-4 text-ink3 ${c.right ? "text-right" : "text-left"} ${c.full ? FULL : ""} ${c.className ?? ""}`}
              >
                {c.srLabel && <span className="sr-only">{c.srLabel}</span>}
                {c.sort ? (
                  <button
                    type="button"
                    title={c.sort.title}
                    className={`inline-flex h-4 items-center gap-1 whitespace-nowrap align-middle leading-4 hover:text-ink ${c.right ? "flex-row-reverse" : ""}`}
                    onClick={c.sort.onToggle}
                  >
                    {c.label}
                    <span aria-hidden className="inline-block w-2 text-[10px] leading-none">
                      {c.sort.dir ? (c.sort.dir === 1 ? "▲" : "▼") : ""}
                    </span>
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** One row height per list; `tall` is for a list whose folded name cell needs a third line. */
export function ListRow({
  id,
  active,
  tall,
  skeleton,
  children,
}: {
  id?: string;
  /** Deep-linked or selected. */
  active?: boolean;
  tall?: boolean;
  skeleton?: boolean;
  children: ReactNode;
}) {
  const height = tall ? "h-[84px] min-[1040px]:h-[60px]" : "h-[60px]";
  const tone = skeleton ? "" : active ? "bg-acc-soft" : "hover:bg-sunk/60";
  return (
    <tr id={id} aria-hidden={skeleton || undefined} className={`group/row ${height} ${tone}`}>
      {children}
    </tr>
  );
}

const VARIANT = {
  text: "",
  /** A count or a size: right aligned, digits line up. */
  num: "text-right font-mono text-xs tabular-nums text-ink2",
  /** A time or a secondary fact. */
  muted: "text-xs text-ink3",
  actions: "text-right",
};

export function ListCell({
  full,
  variant = "text",
  className = "",
  title,
  children,
}: {
  full?: boolean;
  variant?: keyof typeof VARIANT;
  className?: string;
  title?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <td title={title} className={`border-t border-line px-3 align-middle ${full ? FULL : ""} ${VARIANT[variant]} ${className}`}>
      {children}
    </td>
  );
}

/** The count, and room for a "Load more", in a line that keeps its height so nothing below moves. */
export function ListFooter({ children, action }: { children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-3 text-xs tabular-nums text-ink3">
      <span>{children}</span>
      {action}
    </div>
  );
}
