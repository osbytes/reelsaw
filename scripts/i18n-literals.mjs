#!/usr/bin/env node
// Strings and layout that bypass internationalisation (docs/I18N.md), counted for the lint ratchet:
//   i18n/jsx-text       web app: JSX text with letters outside <Trans> / <Plural> / <Select>
//   i18n/string-props   web app: aria-label, title, placeholder, alt and label props given a literal string
//   i18n/physical-css   web app: physical Tailwind classes (ml-, pr-, left-, text-right, rounded-l…) instead of logical ones
//   i18n/server-errors  server: a TRPCError or QuotaError given a literal sentence instead of an AppError with a catalogue message
//   i18n/site-text      website: JSX text with letters (copy renders through t(), website/lib/i18n.ts)
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

/** Server errors for people that skip the catalogue: `new TRPCError({ message: "…" })` / `new QuotaError("…")` with a literal. */
export function serverFindings() {
  const files = execFileSync("git", ["ls-files", "apps/server/src/*.ts", "apps/server/src/**/*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !/\/(eval|dev)\//.test(f));
  const out = [];
  const literal = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!/TRPCError|QuotaError/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["TRPCError", "QuotaError"].includes(node.expression.text)) {
        const [arg] = node.arguments ?? [];
        const message =
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "message")?.initializer
            : arg;
        if (literal(message) && WORDS.test(message.getText(sf)))
          out.push({
            kind: "i18n/server-errors",
            at: `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`,
            text: message.getText(sf).slice(0, 80),
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** Website copy written straight into JSX instead of through the catalogue. */
export function siteFindings() {
  const files = execFileSync("git", ["ls-files", "website/app/*.tsx", "website/app/**/*.tsx", "website/components/*.tsx", "website/components/**/*.tsx"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const out = [];
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isJsxText(node) && WORDS.test(node.text))
        out.push({ kind: "i18n/site-text", at: `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`, text: node.text.trim() });
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/").replace(/^\/?/, "/")}` || process.argv[1]?.endsWith("i18n-literals.mjs")) {
  const found = [...i18nFindings(), ...serverFindings(), ...siteFindings()];
  if (process.argv.includes("--list")) for (const f of found) console.log(`${f.kind}  ${f.at}  ${f.text}`);
  const totals = {};
  for (const f of found) totals[f.kind] = (totals[f.kind] ?? 0) + 1;
  console.log(totals);
}
