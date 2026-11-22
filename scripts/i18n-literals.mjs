#!/usr/bin/env node
// Strings and layout that bypass internationalisation in the web app (docs/I18N.md), counted for the lint ratchet:
//   i18n/jsx-text       JSX text with letters outside <Trans> / <Plural> / <Select>
//   i18n/string-props   aria-label, title, placeholder, alt and label props given a literal string
//   i18n/physical-css   physical Tailwind classes (ml-, pr-, left-, text-right, rounded-l…) instead of logical ones
// Counts per kind; scripts/lint-ratchet.mjs keeps them from rising.
//   node scripts/i18n-literals.mjs           totals
//   node scripts/i18n-literals.mjs --list    every site, for burning them down
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const MACROS = new Set(["Trans", "Plural", "Select", "SelectOrdinal"]);
const PROPS = new Set(["aria-label", "title", "placeholder", "alt", "label"]);
const WORDS = /\p{L}{2,}/u;
// a physical utility as a whole class token, with any variant prefix (sm:, hover:) and an optional leading "-"
const PHYSICAL =
  /(?:^|[\s"'`])(?:[\w-]+:)*-?(?:(?:m[lr]|p[lr]|left|right|scroll-[mp][lr])-[\w./[\]%-]+|(?:border-[lr]|rounded-[lr]|rounded-[tb][lr])(?:-[\w./[\]%-]+)?|text-(?:left|right)|float-(?:left|right)|clear-(?:left|right))(?=$|[\s"'`])/g;

export function i18nFindings() {
  const files = execFileSync("git", ["ls-files", "apps/web/src/*.tsx", "apps/web/src/**/*.tsx"], { encoding: "utf8" }).split("\n").filter(Boolean);
  /** @type {{ kind: string, at: string, text: string }[]} */
  const out = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = (node) => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const insideMacro = (node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isJsxElement(p) && MACROS.has(p.openingElement.tagName.getText(sf))) return true;
      }
      return false;
    };
    const visit = (node) => {
      if (ts.isJsxText(node) && WORDS.test(node.text) && !insideMacro(node)) out.push({ kind: "i18n/jsx-text", at: at(node), text: node.text.trim() });
      if (ts.isJsxAttribute(node) && PROPS.has(node.name.getText(sf)) && node.initializer) {
        const init = node.initializer;
        const lit = ts.isStringLiteral(init)
          ? init
          : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
            ? init.expression
            : null;
        if (lit && WORDS.test(lit.text)) out.push({ kind: "i18n/string-props", at: at(node), text: `${node.name.getText(sf)}="${lit.text}"` });
      }
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        for (const m of node.text.matchAll(PHYSICAL)) out.push({ kind: "i18n/physical-css", at: at(node), text: m[0].trim() });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/").replace(/^\/?/, "/")}` || process.argv[1]?.endsWith("i18n-literals.mjs")) {
  const found = i18nFindings();
  if (process.argv.includes("--list")) for (const f of found) console.log(`${f.kind}  ${f.at}  ${f.text}`);
  const totals = {};
  for (const f of found) totals[f.kind] = (totals[f.kind] ?? 0) + 1;
  console.log(totals);
}
