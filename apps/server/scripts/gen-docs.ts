/**
 * Regenerates the reference sections of the docs from the code that owns the facts:
 *
 *   env vars    src/config.ts (zod schema: names, types, defaults) + scripts/docs-meta.ts (prose)
 *               -> docs/CONFIG.md, .env.example, deploy/.env.example
 *   CLI         the command list at the top of src/cli.ts -> README.md, docs/TROUBLESHOOTING.md
 *   eval suites src/eval/suites/index.ts (name, description, needs) -> docs/EVALS.md, README.md, docs/TROUBLESHOOTING.md
 *   MCP tools   src/mcp-tools.ts (name, title, first sentence of the description) -> README.md
 *
 * Generated text lives between markers and everything outside them is hand-written:
 *   markdown  <!-- generated:NAME --> ... <!-- /generated -->
 *   .env      # >>> generated:NAME ... # <<< generated
 *
 *   pnpm docs:gen     rewrite the blocks
 *   pnpm docs:check   exit 1 when a block is stale or a variable / command is undocumented (run it in CI)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(serverDir, "../..");
const check = process.argv.includes("--check");
process.chdir(serverDir); // schema defaults such as ./models/... are relative to the server dir

const problems: string[] = [];
const meta = await import("./docs-meta.js");

// ---------------------------------------------------------------- env vars

type Row = { name: string; group: string; description: string; def: string; values?: string };

async function envRows(): Promise<Row[]> {
  const { envSchema } = await import("../src/config.js");
  const { RUNTIME_SETTINGS } = await import("../src/instance-settings.js");
  const shape = envSchema.shape as Record<string, any>;
  const parsed = envSchema.parse({ DATABASE_URL: "x", BETTER_AUTH_SECRET: "x".repeat(32) }) as Record<string, unknown>;
  const rows: Row[] = [];
  for (const [name, field] of Object.entries(shape)) {
    const doc = meta.DOCS[name];
    let description: string | undefined = field.description ?? doc?.[1];
    // a runtime setting: the variable is the default; Settings → System, `reelsaw settings` and set_instance_settings override it
    if (description && name in RUNTIME_SETTINGS)
      description = `${description.replace(/\s+$/, "")} Runtime setting: admins can change it under Settings → System without a restart.`;
    if (!description) problems.push(`env ${name} has no description: add one to apps/server/scripts/docs-meta.ts (or .describe() in config.ts)`);
    if (!doc) problems.push(`env ${name} has no group: add it to DOCS in apps/server/scripts/docs-meta.ts`);
    const v = parsed[name];
    let def = v === undefined ? "" : String(v);
    // schema defaults use path.resolve, so Windows emits `\`; docs always show POSIX relative paths
    def = def
      .split(process.cwd() + path.sep)
      .join("./")
      .split(process.cwd())
      .join(".")
      .replace(/\\/g, "/");
    if (name === "DATA_DIR") def = "./data";
    let values: string | undefined;
    let t = field;
    for (let i = 0; i < 6 && t; i++) {
      if (t.def?.entries) values = Object.keys(t.def.entries).join(" | ");
      t = t.def?.innerType ?? t.def?.in;
    }
    rows.push({ name, group: doc?.[0] ?? "core", description: description ?? "TODO", def, values });
  }
  for (const [name, def] of Object.entries(meta.EXTRA_DEFAULTS)) {
    const doc = meta.DOCS[name];
    if (!doc) problems.push(`env ${name} (EXTRA_DEFAULTS) has no entry in DOCS`);
    rows.push({ name, group: doc?.[0] ?? "compose", description: doc?.[1] ?? "TODO", def });
  }
  for (const name of Object.keys(meta.DOCS))
    if (!rows.some((r) => r.name === name)) problems.push(`docs-meta.ts documents ${name}, which is neither in config.ts nor EXTRA_DEFAULTS`);
  const order: string[] = meta.GROUPS.map((g) => g[0]);
  // stable: schema order inside a group
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => order.indexOf(a.r.group) - order.indexOf(b.r.group) || a.i - b.i)
    .map((x) => x.r);
}

/** Text for one markdown table cell: backslashes and pipes escaped, so the row keeps its columns. */
const cell = (s: string) => s.replace(/[\\|]/g, (c) => `\\${c}`);

function configMd(rows: Row[]): string {
  const out: string[] = [];
  for (const [id, title] of meta.GROUPS) {
    const rs = rows.filter((r) => r.group === id);
    if (!rs.length) continue;
    out.push(`### ${title}`, "", "| Variable | Default | Description |", "| --- | --- | --- |");
    for (const r of rs) {
      const def = r.def === "" ? "unset" : `\`${r.def}\``;
      const vals = r.values ? ` Values: \`${r.values}\`.` : "";
      out.push(`| \`${r.name}\` | ${def} | ${cell(r.description)}${vals} |`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function envFile(which: "root" | "deploy", rows: Row[]): string {
  const active = meta.ENV_ACTIVE[which];
  const omit = new Set([...meta.ENV_OMIT[which], ...meta.ENV_OMIT_ALL]);
  const out: string[] = [];
  for (const [id, title] of meta.GROUPS) {
    const rs = rows.filter((r) => r.group === id && !omit.has(r.name));
    if (!rs.length) continue;
    out.push(`# ---- ${title} ----`);
    for (const r of rs) {
      out.push(`# ${r.description.replace(/`/g, "")}${r.values ? ` (${r.values})` : ""}`);
      const on = r.name in active;
      const value = on ? active[r.name]! : (meta.ENV_VALUE[which][r.name] ?? r.def);
      out.push(`${on ? "" : "# "}${r.name}=${value}`);
    }
    out.push("");
  }
  for (const k of Object.keys(active))
    if (!rows.some((r) => r.name === k)) problems.push(`docs-meta.ts ENV_ACTIVE.${which} names ${k}, which is not a known variable`);
  return out.join("\n").trimEnd();
}

// ---------------------------------------------------------------- CLI

function cliCommands(): Array<{ name: string; usage: string; description: string }> {
  const src = fs.readFileSync(path.join(serverDir, "src/cli.ts"), "utf8");
  const lines = src.slice(0, src.indexOf("*/")).split("\n");
  const start = lines.findIndex((l) => /^ \* Commands\s*$/.test(l));
  if (start < 0) throw new Error("cli.ts: the header comment has no 'Commands' section");
  const cmds: Array<{ name: string; usage: string; description: string }> = [];
  for (const l of lines.slice(start + 1)) {
    const first = /^ \* {3}(\S.*)$/.exec(l);
    const more = /^ \*\s{4,}(\S.*)$/.exec(l);
    if (first) {
      // the description is separated from the arguments by a wide gap; arguments may be aligned with 2+ spaces
      const bare = /^(\S+)\s{3,}(\S.*)$/.exec(first[1]!);
      if (bare) {
        cmds.push({ name: bare[1]!, usage: bare[1]!, description: bare[2]! });
      } else {
        const [name, tail = ""] = first[1]!.split(/\s+(.*)/s);
        const [args = "", ...rest] = tail.split(/\s{3,}/);
        cmds.push({ name: name!, usage: `${name} ${args}`.replace(/\s+/g, " ").trim(), description: rest.join(" ").trim() });
      }
    } else if (more && cmds.length) {
      const c = cmds[cmds.length - 1]!;
      c.description = `${c.description} ${more[1]}`.trim();
    }
  }
  // the usage line the CLI prints for an unknown command must list the same commands
  const printed = /console\.log\(\s*"usage: reelsaw <([^>]+)>/.exec(src)?.[1]?.split("|") ?? [];
  const names = new Set(cmds.map((c) => c.name));
  for (const n of printed) if (!names.has(n)) problems.push(`cli.ts prints '${n}' in its usage line but the header comment has no entry for it`);
  for (const n of names) if (!printed.includes(n)) problems.push(`cli.ts header documents '${n}' but its printed usage line does not list it`);
  return cmds;
}

function cliTable(cmds: ReturnType<typeof cliCommands>): string {
  const rows = cmds.map((c) => `| \`reelsaw ${cell(c.usage)}\` | ${cell(c.description) || "see the header of apps/server/src/cli.ts"} |`);
  return [
    "Run as `docker compose exec app reelsaw <command>` (from source: `pnpm --filter @reelsaw/server cli <command>`).",
    "",
    "| Command | What it does |",
    "| --- | --- |",
    ...rows,
  ].join("\n");
}

// ---------------------------------------------------------------- eval suites

async function suiteRows() {
  const { suites } = await import("../src/eval/suites/index.js");
  return suites.map((s) => ({ name: s.name, description: s.description, needs: s.needs }));
}

function suiteTable(rows: Awaited<ReturnType<typeof suiteRows>>): string {
  const lines = ["| Suite | Needs | What it checks |", "| --- | --- | --- |"];
  for (const s of rows) lines.push(`| \`${s.name}\` | ${s.needs.length ? s.needs.join(", ") : "nothing (runs offline)"} | ${cell(s.description)} |`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- MCP tools

async function mcpTable(): Promise<string> {
  const { TOOLS } = await import("../src/mcp-tools.js");
  const lines = ["| Tool | What it does |", "| --- | --- |"];
  for (const [name, t] of Object.entries(TOOLS) as Array<[string, { description: string }]>) {
    const first = /^.*?[.!?](?=\s|$)/.exec(t.description)?.[0] ?? t.description;
    lines.push(`| \`${name}\` | ${cell(first)} |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- blocks

const MD = (name: string) => ({ open: `<!-- generated:${name} -->`, line: `<!-- generated:${name} -->`, close: "<!-- /generated -->" });
const ENVMARK = (name: string) => ({
  open: `# >>> generated:${name}`,
  line: `# >>> generated:${name} (pnpm docs:gen; edit apps/server/scripts/docs-meta.ts, not this block)`,
  close: "# <<< generated",
});

const stale: string[] = [];
function writeBlock(file: string, marks: { open: string; line: string; close: string }, body: string, inline = false) {
  const p = path.join(repo, file);
  const text = fs.readFileSync(p, "utf8");
  const from = text.indexOf(marks.open);
  if (from < 0) return void problems.push(`${file}: missing marker ${marks.open}`);
  const to = text.indexOf(marks.close, from + marks.open.length);
  if (to < 0) return void problems.push(`${file}: missing closing marker ${marks.close} after ${marks.open}`);
  // inline: the block sits inside a sentence (the suite names), so no newlines around the body
  const sep = inline ? "" : "\n";
  const next = text.slice(0, from) + marks.line + sep + body + sep + text.slice(to);
  if (next === text) return;
  if (check) stale.push(file);
  else fs.writeFileSync(p, next);
}

const rows = await envRows();
const cmds = cliCommands();
const suiteInfo = await suiteRows();

writeBlock("docs/CONFIG.md", MD("env"), configMd(rows));
writeBlock(".env.example", ENVMARK("env"), envFile("root", rows));
writeBlock("deploy/.env.example", ENVMARK("env"), envFile("deploy", rows));
writeBlock("README.md", MD("cli"), cliTable(cmds));
writeBlock("docs/TROUBLESHOOTING.md", MD("cli"), cliTable(cmds));
writeBlock("docs/EVALS.md", MD("suites"), suiteTable(suiteInfo));
const names = suiteInfo.map((s) => `\`${s.name}\``).join(", ");
writeBlock("README.md", MD("suite-names"), names, true);
writeBlock("README.md", MD("mcp-tools"), await mcpTable());
writeBlock("docs/TROUBLESHOOTING.md", MD("suite-names"), names, true);

if (problems.length) {
  console.error("docs: problems\n  " + problems.join("\n  "));
  if (check) process.exit(1);
}
if (check && stale.length) {
  console.error(`docs: generated sections are stale in: ${[...new Set(stale)].join(", ")}\nRun: pnpm docs:gen`);
  process.exit(1);
}
console.log(check ? "docs: generated sections are up to date" : "docs: regenerated");
