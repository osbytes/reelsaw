import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config, Paths } from "../config.js";
import type { Logger } from "../log.js";

/**
 * Durable artifact store. Everything ffmpeg touches lives in DATA_DIR (local scratch);
 * uploads, source videos and rendered clips are copied through this interface so any
 * worker on any node can pick a job up, and so clips survive a container rebuild.
 */
export interface Storage {
  readonly driver: "local" | "s3";
  /** Verifies the backend is usable (write probe for local, HeadBucket for S3). */
  check(): Promise<void>;
  /** Copy a local file into the store under `key`. Idempotent. */
  putFile(key: string, localPath: string, contentType?: string): Promise<void>;
  /** Make sure `key` exists at `localPath` (no-op if already there). Returns localPath. */
  ensureLocal(key: string, localPath: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Either a local file path to stream, or a URL to redirect the client to. */
  resolve(key: string, opts?: { downloadName?: string }): Promise<{ file: string } | { url: string }>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Up to `limit` objects under `prefix` (keys as passed to the other methods) with their last-modified time. A bounded listing, not a walk of the bucket. */
  list(prefix: string, limit: number): Promise<Array<{ key: string; modifiedAt: Date }>>;
}

/** Content types for the files this server streams (uploads, library assets, renders); anything else is an octet stream. */
const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".json": "application/json", ".zip": "application/zip",
};
export function contentTypeFor(file: string) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function linkOrCopy(from: string, to: string) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rm(to, { force: true });
  try {
    await fsp.link(from, to);
  } catch {
    // copy under a temp name so an interrupted copy is never mistaken for the finished file
    const tmp = `${to}.${process.pid}.${randomUUID()}.part`;
    try {
      await fsp.copyFile(from, tmp);
      await fsp.rename(tmp, to);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/** True for the errors S3 gives a missing object (HeadObject has no body, so only the status or name tells). */
export function isS3NotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = "name" in err ? err.name : undefined;
  if (name === "NotFound" || name === "NoSuchKey") return true;
  if ("$metadata" in err && typeof err.$metadata === "object" && err.$metadata !== null && "httpStatusCode" in err.$metadata) {
    return err.$metadata.httpStatusCode === 404;
  }
  return false;
}

function safeKey(key: string) {
  const norm = path.posix.normalize(key).replace(/^\/+/, "");
  if (norm.startsWith("..")) throw new Error(`invalid storage key ${key}`);
  return norm;
}

// ---------- local ----------

class LocalStorage implements Storage {
  readonly driver = "local" as const;
  constructor(private root: string) {}
  async check() {
    try {
      await fsp.mkdir(this.root, { recursive: true });
      const probe = path.join(this.root, `.write-test-${process.pid}`);
      await fsp.writeFile(probe, "ok");
      await fsp.rm(probe, { force: true });
    } catch (err) {
      throw new Error(`local storage dir ${this.root} is not writable: ${(err as Error).message}`);
    }
  }
  private abs(key: string) {
    return path.join(this.root, safeKey(key));
  }
  async putFile(key: string, localPath: string) {
    const dest = this.abs(key);
    if (path.resolve(dest) === path.resolve(localPath)) return;
    await linkOrCopy(localPath, dest);
  }
  async ensureLocal(key: string, localPath: string) {
    if (await fileExists(localPath)) return touched(localPath);
    const src = this.abs(key);
    if (!(await fileExists(src))) throw new Error(`storage object missing: ${key}`);
    await linkOrCopy(src, localPath);
    return localPath;
  }
  exists(key: string) {
    return fileExists(this.abs(key));
  }
  async resolve(key: string) {
    return { file: this.abs(key) };
  }
  async delete(key: string) {
    await fsp.rm(this.abs(key), { force: true });
  }
  async deletePrefix(prefix: string) {
    await fsp.rm(this.abs(prefix), { recursive: true, force: true });
  }
  async list(prefix: string, limit: number) {
    const out: Array<{ key: string; modifiedAt: Date }> = [];
    const walk = async (rel: string) => {
      for (const e of await fsp.readdir(this.abs(rel), { withFileTypes: true }).catch(() => [])) {
        if (out.length >= limit) return;
        const child = `${rel.replace(/\/+$/, "")}/${e.name}`;
        if (e.isDirectory()) await walk(child);
        else {
          const st = await fsp.stat(this.abs(child)).catch(() => null);
          if (st) out.push({ key: child, modifiedAt: st.mtime });
        }
      }
    };
    await walk(prefix);
    return out;
  }
}

// ---------- s3 ----------

class S3Storage implements Storage {
  readonly driver = "s3" as const;
  private client: import("@aws-sdk/client-s3").S3Client | undefined;
  private sdk: typeof import("@aws-sdk/client-s3") | undefined;
  constructor(
    private config: Config,
    private bucket: string,
    private prefix: string,
  ) {}

  async check() {
    const { client, sdk } = await this.s3();
    try {
      await client.send(new sdk.HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      throw new Error(`cannot access S3 bucket "${this.bucket}" at ${this.config.S3_ENDPOINT ?? "AWS"}: ${(err as Error).name}: ${(err as Error).message}`);
    }
    // read-only credentials pass HeadBucket; fail at boot, not after a 2 GB download
    const probe = this.k(`.reelsaw-check-${randomUUID()}`);
    try {
      await client.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key: probe, Body: "ok" }));
      await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: probe }));
    } catch (err) {
      throw new Error(`S3 bucket "${this.bucket}" is readable but not writable (put/delete of a probe object failed): ${(err as Error).name}: ${(err as Error).message}`);
    }
  }

  private async s3() {
    if (this.client && this.sdk) return { client: this.client, sdk: this.sdk };
    const sdk = await import("@aws-sdk/client-s3");
    const { config } = this;
    const client = new sdk.S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
    this.client = client;
    this.sdk = sdk;
    return { client, sdk };
  }
  private k(key: string) {
    return this.prefix ? `${this.prefix.replace(/\/+$/, "")}/${safeKey(key)}` : safeKey(key);
  }

  async putFile(key: string, localPath: string, contentType = contentTypeFor(localPath)) {
    const { client } = await this.s3();
    const { Upload } = await import("@aws-sdk/lib-storage");
    const upload = new Upload({
      client,
      params: { Bucket: this.bucket, Key: this.k(key), Body: fs.createReadStream(localPath), ContentType: contentType },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
    });
    await upload.done();
  }

  /** Pulls in flight in this process, by destination: concurrent callers share one download. */
  private pulls = new Map<string, Promise<string>>();

  ensureLocal(key: string, localPath: string): Promise<string> {
    const running = this.pulls.get(localPath);
    if (running) return running;
    const pull = this.pull(key, localPath).finally(() => this.pulls.delete(localPath));
    this.pulls.set(localPath, pull);
    return pull;
  }

  private async pull(key: string, localPath: string) {
    if (await fileExists(localPath)) return touched(localPath);
    const { client, sdk } = await this.s3();
    const res = await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
    if (!res.Body) throw new Error(`storage object missing: ${key}`);
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    const tmp = `${localPath}.${process.pid}.${randomUUID()}.part`;
    try {
      await pipeline(res.Body as Readable, fs.createWriteStream(tmp));
      if (await fileExists(localPath)) await fsp.rm(tmp, { force: true }); // another process got there first
      else await fsp.rename(tmp, localPath);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return localPath;
  }

  async exists(key: string) {
    const { client, sdk } = await this.s3();
    try {
      await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return true;
    } catch (err) {
      if (isS3NotFound(err)) return false;
      throw err;
    }
  }

  async resolve(key: string, opts?: { downloadName?: string }) {
    if (this.config.S3_PUBLIC_URL && !opts?.downloadName) {
      return { url: `${this.config.S3_PUBLIC_URL.replace(/\/+$/, "")}/${this.k(key)}` };
    }
    const { client, sdk } = await this.s3();
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const cmd = new sdk.GetObjectCommand({
      Bucket: this.bucket,
      Key: this.k(key),
      ResponseContentDisposition: opts?.downloadName ? `attachment; filename="${opts.downloadName.replace(/"/g, "")}"` : undefined,
    });
    const url = await getSignedUrl(client, cmd, { expiresIn: this.config.S3_PRESIGN_EXPIRES });
    return { url };
  }

  async delete(key: string) {
    const { client, sdk } = await this.s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
  }

  async deletePrefix(prefix: string) {
    const { client, sdk } = await this.s3();
    let token: string | undefined;
    do {
      const page = await client.send(
        new sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.k(prefix).replace(/\/?$/, "/"), ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await client.send(new sdk.DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async list(prefix: string, limit: number) {
    const { client, sdk } = await this.s3();
    const root = this.prefix ? `${this.prefix.replace(/\/+$/, "")}/` : "";
    const out: Array<{ key: string; modifiedAt: Date }> = [];
    let token: string | undefined;
    do {
      const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.k(prefix).replace(/\/?$/, "/"), MaxKeys: Math.min(1000, limit - out.length), ContinuationToken: token }));
      for (const o of page.Contents ?? []) if (o.Key && o.LastModified) out.push({ key: o.Key.slice(root.length), modifiedAt: o.LastModified });
      token = page.IsTruncated && out.length < limit ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

async function fileExists(file: string) {
  try {
    return (await fsp.stat(file)).size > 0;
  } catch {
    return false;
  }
}

/** Log a failed write, fetch or delete at warn with its key; behaviour is unchanged. Successes are not logged (bytes are in the rows, timing in spans). */
export function withStorageLogging(inner: Storage, log: Logger): Storage {
  const timed = async <T>(op: string, key: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      log.warn({ err, op, key, driver: inner.driver }, "storage operation failed");
      throw err;
    }
  };
  return {
    driver: inner.driver,
    check: () => inner.check(),
    putFile: (key, localPath, contentType) => timed("put", key, () => inner.putFile(key, localPath, contentType)),
    ensureLocal: (key, localPath) => timed("ensureLocal", key, () => inner.ensureLocal(key, localPath)),
    exists: (key) => inner.exists(key),
    resolve: (key, opts) => inner.resolve(key, opts),
    delete: (key) => timed("delete", key, () => inner.delete(key)),
    deletePrefix: (prefix) => timed("deletePrefix", prefix, () => inner.deletePrefix(prefix)),
    list: (prefix, limit) => timed("list", prefix, () => inner.list(prefix, limit)),
  };
}

/** A cache hit bumps the file's mtime so the scratch sweep evicts by last use, not by first pull (storage/sweep.ts). */
async function touched(file: string) {
  const now = new Date();
  await fsp.utimes(file, now, now).catch(() => {});
  return file;
}

export function createStorage(config: Config, paths: Paths, log?: Logger): Storage {
  const inner: Storage = config.STORAGE_DRIVER === "s3" ? new S3Storage(config, config.S3_BUCKET!, config.S3_PREFIX ?? "") : new LocalStorage(config.STORAGE_LOCAL_DIR ?? paths.storage);
  return log ? withStorageLogging(inner, log) : inner;
}

// ---------- key helpers ----------
export const ASR_CACHE_PREFIX = "cache/asr/";
export const keys = {
  upload: (id: string, ext: string) => `uploads/${id}${ext}`,
  source: (projectId: string, ext: string) => `projects/${projectId}/source${ext}`,
  // one file per render generation: a stale render can never overwrite a newer one's output
  clip: (projectId: string, clipId: string, gen = 0) => `projects/${projectId}/clips/${clipId}${gen ? `.${gen}` : ""}.mp4`,
  thumb: (projectId: string, clipId: string, gen = 0) => `projects/${projectId}/clips/${clipId}${gen ? `.${gen}` : ""}.jpg`,
  /** a library asset as uploaded; assets are immutable, so the key never changes. Rows made before the library held more than intros/outros live under `bumpers/<id>/…` (their `source_key` says so) */
  asset: (id: string, ext: string) => `assets/${id}/source${ext}`,
  /** the folder an asset's derived files share with its source (`bumpers/<id>` or `assets/<id>`) */
  assetDir: (sourceKey: string) => sourceKey.slice(0, sourceKey.lastIndexOf("/")),
  assetThumb: (sourceKey: string) => `${keys.assetDir(sourceKey)}/thumb.jpg`,
  /** derived cache: the asset normalised to the render canvas (`variant` names canvas + encode version) */
  assetNorm: (sourceKey: string, variant: string) => `${keys.assetDir(sourceKey)}/norm.${variant}.mp4`,
  /** derived cache: an SVG rasterised once at the render width */
  assetRaster: (sourceKey: string, variant: string) => `${keys.assetDir(sourceKey)}/raster.${variant}.png`,
  /** a speech-to-text result (ai/asr.ts) shared across hosts when the store is S3; `sha` is the cache key */
  asrCache: (sha: string) => `${ASR_CACHE_PREFIX}${sha}.json`,
  projectPrefix: (projectId: string) => `projects/${projectId}`,
};
