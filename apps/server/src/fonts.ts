/**
 * Fonts for captions, hooks, text layers and the watermark: the ones installed in the image (`TEXT_FONTS`, the pickers'
 * list), any other family fontconfig has (a custom image's fonts: valid for CAPTION_FONT and the API, not listed), plus
 * the ones an admin uploaded (`fonts` table, objects under `fonts/` in the store). One list for every surface: Settings →
 * System → Captions, the editor's pickers, `list_fonts` / `add_font` / `remove_font` and `reelsaw fonts`.
 *
 * Which font a clip uses (README, "Settings and precedence"): the clip's style `font`, then the project's, then the
 * instance's CAPTION_FONT (`.env`, then the admin's runtime override). A family that is no longer available (an
 * uploaded font removed, a typo through the API) falls back down that chain and finally to DejaVu Sans, so a render
 * never fails and never silently picks whatever fontconfig substitutes. The watermark uses the instance font only:
 * it is the operator's mark, not the account's style.
 *
 * Render jobs on any host copy the uploaded files into `DATA_DIR/fonts` (`ensureFontsDir`) and hand that folder to
 * libass (`fontsdir`); the system fonts stay available through fontconfig as before.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { FONT_FILE_EXTS, MAX_FONT_BYTES, TEXT_FONTS, fontFamilySchema } from "@reelsaw/shared";
import { schema, type Db } from "./db/index.js";
import { takeTxLock, txLock } from "./locks.js";
import type { Services } from "./services.js";
import { msg } from "@lingui/core/runtime-macro";
import { AppError, type MessageDescriptor, t } from "./i18n.js";

const execFileAsync = promisify(execFile);

/** The built-in fallback when nothing in the chain is available: always in the image. */
export const FALLBACK_FONT = TEXT_FONTS[0].family;

export type FontsActor = { id: string; email: string };

export interface FontInfo {
  family: string;
  /** how pickers show it */
  label: string;
  /** installed in the image; false = uploaded by an admin (removable) */
  builtin: boolean;
  id: string | null;
  filename: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
  createdBy: string | null;
}

const fontKey = (id: string, ext: string) => `fonts/${id}${ext}`;
/** The folder render jobs and the preview route read uploaded fonts from. */
export const fontsDir = (svc: Pick<Services, "paths">) => path.join(svc.paths.root, "fonts");
const localName = (row: { id: string; storageKey: string }) => `${row.id}${path.extname(row.storageKey)}`;

/**
 * The families fontconfig knows on this host (`fc-list`), every localised name included, read once per process: the
 * image does not change while it runs. Empty where fontconfig is missing (a dev machine); the image's TEXT_FONTS
 * still count there.
 */
let installed: Promise<string[]> | null = null;
export function installedFamilies(): Promise<string[]> {
  installed ??= execFileAsync("fc-list", ["--format", "%{family}\n"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })
    .then(({ stdout }) => [...new Set(stdout.split("\n").flatMap((l) => l.split(",").map((f) => f.trim())))].filter(Boolean))
    .catch(() => {
      // a timeout under load must not disable the image's fonts until a restart: the next call asks again
      installed = null;
      return [] as string[];
    });
  return installed;
}

/** What every font decision reads: the uploaded rows and every family a style may name (lower-cased → as installed). */
export interface FontState {
  uploaded: Array<{ id: string; family: string; storageKey: string }>;
  available: Map<string, string>;
}
export async function loadFontState(db: Db): Promise<FontState> {
  const [uploaded, system] = await Promise.all([
    db.select({ id: schema.fonts.id, family: schema.fonts.family, storageKey: schema.fonts.storageKey }).from(schema.fonts),
    installedFamilies(),
  ]);
  const all = [...system, ...TEXT_FONTS.map((f) => f.family as string), ...uploaded.map((r) => r.family)];
  return { uploaded, available: new Map(all.map((f) => [f.toLowerCase(), f])) };
}

/**
 * The fonts the pickers offer: the image's, then the uploaded ones by name, with the font a style without its own uses
 * (`defaultFamily`: the instance's CAPTION_FONT, or the fallback when that is not available). A CAPTION_FONT from a
 * custom image is listed too, so a picker can show it. Who uploaded a font, and its file name, are for admins only.
 */
export async function listFonts(svc: Pick<Services, "database" | "settings">, opts: { admin: boolean }): Promise<{ fonts: FontInfo[]; defaultFamily: string }> {
  const [rows, state] = await Promise.all([svc.database.db.select().from(schema.fonts).orderBy(asc(schema.fonts.family)), loadFontState(svc.database.db)]);
  const defaultFamily = pickFont(state.available, svc.settings.get().CAPTION_FONT);
  const builtin = (family: string, label: string): FontInfo => ({
    family,
    label,
    builtin: true,
    id: null,
    filename: null,
    sizeBytes: null,
    createdAt: null,
    createdBy: null,
  });
  const listed = new Set([...TEXT_FONTS.map((f) => f.family.toLowerCase()), ...rows.map((r) => r.family.toLowerCase())]);
  return {
    defaultFamily,
    fonts: [
      ...TEXT_FONTS.map((f) => builtin(f.family, f.label)),
      ...(listed.has(defaultFamily.toLowerCase()) ? [] : [builtin(defaultFamily, defaultFamily)]),
      ...rows.map(
        (r): FontInfo => ({
          family: r.family,
          label: r.family,
          builtin: false,
          id: r.id,
          filename: opts.admin ? r.filename : null,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt.toISOString(),
          createdBy: opts.admin ? r.createdBy : null,
        }),
      ),
    ],
  };
}

/** The first candidate that is available (as installed, so libass matches it exactly), else the built-in fallback. Pure. */
export function pickFont(available: ReadonlyMap<string, string>, ...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const hit = c ? available.get(c.trim().toLowerCase()) : undefined;
    if (hit) return hit;
  }
  return FALLBACK_FONT;
}

/**
 * The family name FreeType reads from a font file (`fc-scan`), or null when it is not a font this server can draw.
 * A file may name several families (localised names); the first is the one fontconfig matches by.
 */
export async function readFontFamily(file: string): Promise<string | null> {
  let out: string;
  try {
    ({ stdout: out } = await execFileAsync("fc-scan", ["--format", "%{family}\n", file], { timeout: 20_000 }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("fontconfig (fc-scan) is not installed on this server, so fonts cannot be added");
    return null;
  }
  const first = out.split("\n")[0]?.split(",")[0]?.trim();
  return first ? first : null;
}

/** Why a file cannot be a font upload, before anything is read from it, or null: the message, for an AppError. Pure. */
function fontFileProblemMessage(filename: string, sizeBytes: number): MessageDescriptor | null {
  const ext = path.extname(filename).toLowerCase();
  if (!(FONT_FILE_EXTS as readonly string[]).includes(ext))
    return msg({ id: "font.file_type", message: msg`Fonts are ${{ types: FONT_FILE_EXTS.join(", ") }} files.` });
  if (sizeBytes <= 0) return msg({ id: "font.file_empty", message: "The file is empty." });
  if (sizeBytes > MAX_FONT_BYTES)
    return msg({
      id: "font.file_too_large",
      message: msg`The file is ${{ sizeMb: Math.ceil(sizeBytes / 1048576) }} MB; a font may be ${{ maxMb: MAX_FONT_BYTES / 1048576 }} MB at most.`,
    });
  return null;
}

/** Why a file cannot be a font upload, before anything is read from it, or null, as a sentence in the current locale. Pure. */
export function fontFileProblem(filename: string, sizeBytes: number): string | null {
  const problem = fontFileProblemMessage(filename, sizeBytes);
  return problem ? t(problem) : null;
}

/**
 * Add a font from a file on this machine: checked by extension and size, read by FreeType for its family name (which
 * also refuses anything libass could not draw), stored, then recorded with one `fonts.changed` event. A family that is
 * already available (built in or uploaded) is refused: two files for one name leave fontconfig to choose.
 */
export async function addFont(
  svc: Services,
  actor: FontsActor,
  input: { file: string; filename: string /** the upload the file came from, dropped with the insert */; upload?: { id: string; storageKey: string } },
): Promise<FontInfo> {
  const st = await fs.stat(input.file);
  const problem = fontFileProblemMessage(input.filename, st.size);
  if (problem) throw new AppError("BAD_REQUEST", problem);
  const raw = await readFontFamily(input.file);
  if (!raw) throw new AppError("BAD_REQUEST", msg({ id: "font.file_could_not_read_font", message: "This file could not be read as a font." }));
  const parsed = fontFamilySchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      "BAD_REQUEST",
      msg({ id: "font.name_unusable", message: msg`The font's name "${{ name: raw.slice(0, 80) }}" cannot be used in captions.` }),
    );
  const family = parsed.data;
  const id = randomUUID();
  const ext = path.extname(input.filename).toLowerCase();
  const storageKey = fontKey(id, ext);
  // the object goes in first (a row must never point at a missing file); a refused insert removes it below
  await svc.storage.putFile(storageKey, input.file);
  let stored = false;
  try {
    const row = await svc.tx(async (u) => {
      await takeTxLock(u.db, txLock.fonts());
      // the image's other fonts count too: a second file under an installed name leaves libass to pick either
      const state = await loadFontState(u.db);
      const existing = state.available.get(family.toLowerCase());
      if (existing) {
        const uploaded = state.uploaded.some((f) => f.family.toLowerCase() === family.toLowerCase());
        throw new AppError(
          "CONFLICT",
          uploaded
            ? msg({ id: "font.already_uploaded", message: msg`A font named ${{ existing }} is already uploaded. Remove it first to replace it.` })
            : msg({ id: "font.already_built_in", message: msg`${{ existing }} already comes with this server, so it needs no upload: pick it by name.` }),
        );
      }
      const [r] = await u.db
        .insert(schema.fonts)
        .values({ id, family, storageKey, filename: path.basename(input.filename).slice(0, 200), sizeBytes: st.size, createdBy: actor.email })
        .returning();
      await u.emit(
        "fonts.changed",
        { userId: actor.id, email: actor.email, added: [{ id, family }], removed: [] },
        { actorId: actor.id === "cli" ? null : actor.id },
      );
      if (input.upload) {
        // the upload was only the way in: the font has its own object now
        const up = input.upload;
        await u.db.delete(schema.uploads).where(eq(schema.uploads.id, up.id));
        u.afterCommit(() =>
          svc.storage.delete(up.storageKey).catch((err) => svc.log.warn({ err, uploadId: up.id }, "could not delete the font's upload object")),
        );
      }
      u.afterCommit(() => {
        stored = true;
      });
      return r!;
    });
    return {
      family: row.family,
      label: row.family,
      builtin: false,
      id: row.id,
      filename: row.filename,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
    };
  } finally {
    if (!stored) await svc.storage.delete(storageKey).catch((err) => svc.log.warn({ err, storageKey }, "could not remove the refused font object"));
  }
}

/** `add_font` / the Settings upload: the admin's own upload (POST /api/upload) becomes a font, and the upload is dropped. */
export async function addFontFromUpload(svc: Services, actor: FontsActor, uploadId: string): Promise<FontInfo> {
  const up = await svc.database.db.query.uploads.findFirst({ where: and(eq(schema.uploads.id, uploadId), eq(schema.uploads.userId, actor.id)) });
  if (!up) throw new AppError("NOT_FOUND", msg({ id: "font.upload_not_found", message: "Upload not found" }));
  // cheap checks before the bytes are pulled out of the store
  const problem = fontFileProblemMessage(up.filename, up.sizeBytes);
  if (problem) throw new AppError("BAD_REQUEST", problem);
  await fs.mkdir(svc.paths.tmp, { recursive: true });
  const local = path.join(svc.paths.tmp, `font-${randomUUID()}${path.extname(up.filename).toLowerCase()}`);
  try {
    await svc.storage.ensureLocal(up.storageKey, local);
    return await addFont(svc, actor, { file: local, filename: up.filename, upload: { id: up.id, storageKey: up.storageKey } });
  } finally {
    await fs.rm(local, { force: true }).catch(() => {});
  }
}

/**
 * Remove uploaded fonts for good (ids from `listFonts`). Styles and layers that name one keep the name and fall back to
 * the instance caption font (or DejaVu Sans) on their next render; clips already rendered keep the font they have.
 */
export async function removeFonts(svc: Services, actor: FontsActor, ids: string[]): Promise<{ removed: Array<{ id: string; family: string }> }> {
  if (ids.length === 0) return { removed: [] };
  return svc.tx(async (u) => {
    await takeTxLock(u.db, txLock.fonts());
    const rows = await u.db
      .delete(schema.fonts)
      .where(inArray(schema.fonts.id, ids))
      .returning({ id: schema.fonts.id, family: schema.fonts.family, storageKey: schema.fonts.storageKey });
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length)
      throw new AppError(
        "NOT_FOUND",
        msg({ id: "font.not_uploaded", message: msg`No uploaded font with id ${{ id: missing[0] ?? "" }} (built-in fonts cannot be removed).` }),
      );
    const removed = rows.map((r) => ({ id: r.id, family: r.family }));
    await u.emit("fonts.changed", { userId: actor.id, email: actor.email, added: [], removed }, { actorId: actor.id === "cli" ? null : actor.id });
    u.afterCommit(async () => {
      for (const r of rows) {
        await svc.storage.delete(r.storageKey).catch((err) => svc.log.warn({ err, fontId: r.id }, "could not delete the font object"));
        await fs.rm(path.join(fontsDir(svc), localName(r)), { force: true }).catch(() => {});
      }
    });
    return { removed };
  });
}

/**
 * Make `DATA_DIR/fonts` hold the uploaded fonts this render names (pulled from the store on a host that lacks them),
 * for libass's `fontsdir`, and drop copies of fonts removed since. Returns the folder, or null when none of the
 * families is an uploaded font (the filter then needs no fontsdir).
 */
export async function ensureFontsDir(
  svc: Pick<Services, "paths" | "storage" | "log">,
  state: FontState,
  families: ReadonlyArray<string | null | undefined>,
): Promise<string | null> {
  const dir = fontsDir(svc);
  const known = new Set(state.uploaded.map(localName));
  const have = await fs.readdir(dir).catch(() => [] as string[]);
  // a font removed while this host was down: drop its copy. A `.part` is another job's pull in flight unless it is
  // old enough to be a crash's leftover
  for (const f of have) {
    if (known.has(f)) continue;
    const file = path.join(dir, f);
    if (f.endsWith(".part")) {
      const st = await fs.stat(file).catch(() => null);
      if (!st || Date.now() - st.mtimeMs < 60 * 60_000) continue;
    }
    await fs.rm(file, { force: true }).catch(() => {});
  }
  const used = new Set(families.filter((f): f is string => !!f).map((f) => f.toLowerCase()));
  const rows = state.uploaded.filter((r) => used.has(r.family.toLowerCase()));
  if (rows.length === 0) return null;
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    rows.map((r) =>
      svc.storage.ensureLocal(r.storageKey, path.join(dir, localName(r))).catch((err) => {
        // one missing object must not stop the render: text in it falls back to whatever fontconfig substitutes
        svc.log.warn({ err, fontId: r.id }, "could not fetch an uploaded font");
      }),
    ),
  );
  return dir;
}

/** The local file of an uploaded font, by family (the editor preview), or null when it is not an uploaded font. */
export async function uploadedFontFile(svc: Pick<Services, "paths" | "storage" | "database">, family: string): Promise<string | null> {
  const [row] = await svc.database.db.select().from(schema.fonts).where(sql`lower(${schema.fonts.family}) = ${family.toLowerCase()}`).limit(1);
  if (!row) return null;
  const dir = fontsDir(svc);
  await fs.mkdir(dir, { recursive: true });
  return svc.storage.ensureLocal(row.storageKey, path.join(dir, localName(row)));
}

// ---------- glyph coverage: which characters the fonts can draw ----------

/** Code point ranges a font (or a set of fonts) has glyphs for, sorted and merged: fontconfig's charset. */
export type Glyphs = Array<[number, number]>;

/** fontconfig's `%{charset}` ("20-7e a0-17f 384") as ranges. Pure. */
export function parseCharset(text: string): Glyphs {
  const out: Glyphs = [];
  for (const part of text.trim().split(/\s+/)) {
    const m = /^([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(part);
    if (m) out.push([Number.parseInt(m[1]!, 16), Number.parseInt(m[2] ?? m[1]!, 16)]);
  }
  return mergeGlyphs(out);
}

/** The union of several coverages. Pure. */
export function mergeGlyphs(...sets: Glyphs[]): Glyphs {
  const all = sets.flat().sort((a, b) => a[0] - b[0]);
  const out: Glyphs = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function hasGlyph(set: Glyphs, cp: number): boolean {
  let lo = 0;
  let hi = set.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = set[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** The characters of `text` none of the fonts draws (spaces and invisible format controls need no glyph). Pure. */
export function missingGlyphs(set: Glyphs, text: string): string[] {
  const out = new Set<string>();
  for (const c of text) if (!/[\s\p{Cf}]/u.test(c) && !hasGlyph(set, c.codePointAt(0)!)) out.add(c);
  return [...out];
}

const charsetOf = (args: string[]) =>
  execFileAsync(args[0]!, args.slice(1), { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }).then(({ stdout }) =>
    mergeGlyphs(...stdout.split("\n").map(parseCharset)),
  );

/**
 * What the fonts installed on this host draw together (`fc-list`): libass falls back from any caption font, uploaded
 * ones included, to an installed font that has the glyph, so this union is what every caption can show. Read once
 * per process; null where fontconfig is missing (a dev machine), which means unknown, not "nothing".
 */
let systemGlyphsP: Promise<Glyphs | null> | null = null;
export function systemGlyphs(): Promise<Glyphs | null> {
  systemGlyphsP ??= charsetOf(["fc-list", "--format", "%{charset}\n"]).catch(() => {
    systemGlyphsP = null;
    return null;
  });
  return systemGlyphsP;
}

/** Each uploaded font's coverage (`fc-scan` on its file), cached by id: an upload's file never changes. */
const uploadedGlyphsCache = new Map<string, Promise<Glyphs | null>>();
export async function uploadedGlyphs(
  svc: Pick<Services, "paths" | "storage" | "log">,
  uploaded: FontState["uploaded"],
): Promise<Array<{ family: string; glyphs: Glyphs }>> {
  const dir = fontsDir(svc);
  const out = await Promise.all(
    uploaded.map(async (r) => {
      let p = uploadedGlyphsCache.get(r.id);
      if (!p) {
        p = fs
          .mkdir(dir, { recursive: true })
          .then(() => svc.storage.ensureLocal(r.storageKey, path.join(dir, localName(r))))
          .then((file) => charsetOf(["fc-scan", "--format", "%{charset}\n", file]))
          .catch((err: unknown) => {
            uploadedGlyphsCache.delete(r.id);
            svc.log.warn({ err, fontId: r.id }, "could not read an uploaded font's characters");
            return null;
          });
        uploadedGlyphsCache.set(r.id, p);
      }
      const glyphs = await p;
      return glyphs ? { family: r.family, glyphs } : null;
    }),
  );
  return out.filter((x): x is { family: string; glyphs: Glyphs } => x !== null);
}
