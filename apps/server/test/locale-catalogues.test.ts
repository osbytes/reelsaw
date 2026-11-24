/**
 * Every shipped locale's catalogues (docs/I18N.md "Adding a language"): the web app's, the server's and reelsaw.com's
 * exist and are listed in each lingui config and the site's catalogue map, and every translation is ICU that keeps the
 * English message's arguments, `<n>` tags and select keys, with a plural for each of the locale's CLDR categories.
 * A translation Lingui cannot parse renders as its raw text (braces and all), and a dropped argument silently loses a
 * value, so neither may ship. Text only: no database, no network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { formatter } from "@lingui/format-po";
import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { DEFAULT_LOCALE, SHIPPED_LOCALES } from "@reelsaw/shared";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CATALOGUES = {
  web: { dir: "apps/web/src/locales", config: "apps/web/lingui.config.ts" },
  server: { dir: "apps/server/assets/locales", config: "apps/server/lingui.config.ts" },
  website: { dir: "website/locales", config: "website/lib/locales.ts" },
} as const;

type Compiled = ReturnType<typeof compileMessageOrThrow>;
type Entry = { message?: string; translation?: string };

const po = formatter({ lineNumbers: false });
function load(dir: string, locale: string): Record<string, Entry> {
  const file = path.join(ROOT, dir, `${locale}.po`);
  return po.parse(readFileSync(file, "utf8"), { locale, sourceLocale: DEFAULT_LOCALE, filename: file }) as unknown as Record<string, Entry>;
}

type Shape = {
  args: string[];
  tags: string[];
  /** literal `{` / `}` in the text: Lingui's parser lets a stray or doubled brace through and renders it as written */
  braces: number;
  selects: string[];
  plurals: { name: string; keys: string[]; same: boolean }[];
};
function shape(c: Compiled): Shape {
  const out: Shape = { args: [], tags: [], braces: 0, selects: [], plurals: [] };
  const walk = (parts: Compiled | string | undefined) => {
    if (parts === undefined) return;
    for (const p of typeof parts === "string" ? [parts] : parts) {
      if (typeof p === "string") {
        out.tags.push(...(p.match(/<\/?\d+\/?>/g) ?? []));
        out.braces += (p.match(/[{}]/g) ?? []).length;
        continue;
      }
      if (!Array.isArray(p)) continue;
      const [name, type, options] = p as [string, string?, Record<string, Compiled | string | undefined>?];
      if (name !== "#" && !out.args.includes(name)) out.args.push(name);
      if (!options) continue;
      // `offset` is the plural's offset, not a branch
      const opts = Object.fromEntries(Object.entries(options).filter(([k, v]) => k !== "offset" && v !== undefined));
      if (type === "select") out.selects.push(`${name}: ${Object.keys(opts).sort().join(",")}`);
      if (type === "plural" || type === "selectordinal") {
        const branches = Object.values(opts).map((v) => JSON.stringify(v));
        out.plurals.push({ name, keys: Object.keys(opts), same: branches.every((b) => b === branches[0]) });
      }
      for (const v of Object.values(opts)) walk(v);
    }
  };
  walk(c);
  out.args.sort();
  out.tags.sort();
  out.selects.sort();
  return out;
}

const TRANSLATED = SHIPPED_LOCALES.filter((l) => l !== DEFAULT_LOCALE);

describe("shipped locale catalogues", () => {
  for (const [name, { dir, config }] of Object.entries(CATALOGUES)) {
    it(`${name}: no English message has literal braces (code samples stay out of the catalogue)`, () => {
      const bad = Object.entries(load(dir, DEFAULT_LOCALE))
        .filter(([id, m]) => shape(compileMessageOrThrow(m.translation || m.message || id)).braces > 0)
        .map(([id]) => id);
      assert.deepEqual(bad, []);
    });

    it(`${name}: ${config} lists every shipped locale`, () => {
      const text = readFileSync(path.join(ROOT, config), "utf8");
      for (const locale of SHIPPED_LOCALES) assert.match(text, new RegExp(`"${locale}"`), `${locale} missing from ${config}`);
    });

    for (const locale of TRANSLATED) {
      it(`${name}: ${locale} translations keep the English arguments, tags and branches`, () => {
        const en = load(dir, DEFAULT_LOCALE);
        const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        const bad: string[] = [];
        for (const [id, m] of Object.entries(load(dir, locale))) {
          if (!m.translation) continue;
          const source = en[id]?.translation || en[id]?.message || m.message || id;
          let compiled: Compiled;
          try {
            compiled = compileMessageOrThrow(m.translation);
          } catch (e) {
            bad.push(`${id}: not ICU (${(e as Error).message.split("\n")[0]})`);
            continue;
          }
          const tr = shape(compiled);
          const src = shape(compileMessageOrThrow(source));
          if (tr.args.join() !== src.args.join()) bad.push(`${id}: arguments ${src.args} → ${tr.args}`);
          if (tr.tags.join() !== src.tags.join()) bad.push(`${id}: tags ${src.tags} → ${tr.tags}`);
          if (tr.braces !== src.braces) bad.push(`${id}: ${src.braces} literal braces → ${tr.braces}`);
          if (tr.selects.join("; ") !== src.selects.join("; ")) bad.push(`${id}: select ${src.selects} → ${tr.selects}`);
          for (const p of tr.plurals) {
            if (!p.keys.includes("other")) bad.push(`${id}: plural ${p.name} has no other`);
            // a plural only there to format its number ({n, plural, other {#}}), or a word that does not inflect, needs one form
            const missing = categories.filter((c) => !p.keys.includes(c));
            if (!p.same && p.keys.some((k) => k !== "other") && missing.length) bad.push(`${id}: plural ${p.name} lacks ${missing}`);
          }
        }
        assert.deepEqual(bad, []);
      });
    }
  }
});
