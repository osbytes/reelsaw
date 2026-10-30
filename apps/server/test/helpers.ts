/**
 * Helpers for tests that run against the local stack (docker compose up): throwaway users made
 * through the real sign-up endpoint, fixture rows written straight to the dev database, and zip
 * reading. Everything a test creates is deleted in its `after` hook.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import yauzl from "yauzl";

export const BASE = process.env.REELSAW_URL ?? "http://localhost:3100";
const repoRoot = path.resolve(import.meta.dirname, "../../..");

/** The repo's .env (what the running app was started with), parsed loosely. */
export function dotenv(): Record<string, string> {
  const file = path.join(repoRoot, ".env");
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
  }
  return out;
}

export function db(): pg.Pool {
  const pw = dotenv().POSTGRES_PASSWORD ?? "reelsaw";
  return new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? `postgres://reelsaw:${pw}@127.0.0.1:5432/reelsaw` });
}

export async function signUp(opts?: { password?: string }): Promise<{ email: string; cookie: string; userId: string; password: string }> {
  const email = `test-${randomUUID().slice(0, 8)}@example.test`;
  const password = opts?.password ?? `pw-${randomUUID()}`;
  let res!: Response;
  // Better Auth allows 3 sign-ups per 10 s; suites run in parallel and each makes a few users
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password, name: "Test" }),
    });
    if (res.status !== 429 || attempt >= 12) break;
    await res.text();
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 1500));
  }
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const body = (await res.json()) as { user: { id: string } };
  return { email, cookie, userId: body.user.id, password };
}

/** Create an API key for a signed-in account (the same call Settings → API keys makes). */
export async function createKey(cookie: string, name: string): Promise<{ id: string; key: string }> {
  const res = await fetch(`${BASE}/api/auth/api-key/create`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify({ name }),
  });
  const body = await res.text();
  if (res.status !== 200) throw new Error(`api-key/create ${res.status}: ${body}`);
  return JSON.parse(body) as { id: string; key: string };
}

export async function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) => yauzl.fromBuffer(buf, { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z!))));
  const out = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks: Buffer[] = [];
        stream!
          .on("data", (c: Buffer) => chunks.push(c))
          .on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
      });
    });
    zip.on("end", resolve).on("error", reject);
    zip.readEntry();
  });
  return out;
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

import { execFileSync, spawnSync } from "node:child_process";
import zlib from "node:zlib";

/** Run `reelsaw <args>` inside the app container; returns exit code and combined output. */
export function cli(args: string[]): { code: number; out: string } {
  const r = spawnSync("docker", ["compose", "exec", "-T", "app", "reelsaw", ...args], { cwd: repoRoot, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

/** Copy a local file into the app container (under /data/tmp) and return its path there. */
export function toContainer(local: string, name: string): string {
  const dest = `/data/tmp/${name}`;
  execFileSync("docker", ["compose", "cp", local, `app:${dest}`], { cwd: repoRoot, stdio: "ignore" });
  return dest;
}

export function inContainer(cmd: string) {
  spawnSync("docker", ["compose", "exec", "-T", "app", "sh", "-c", cmd], { cwd: repoRoot, stdio: "ignore" });
}

/** A minimal stored (uncompressed) zip, so tests can write entries no zip library would. */
export function rawZip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = typeof e.data === "string" ? Buffer.from(e.data) : e.data;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
