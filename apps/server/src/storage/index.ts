import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config, Paths } from "../config.js";

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
}

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg" };
export function contentTypeFor(file: string) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function linkOrCopy(from: string, to: string) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rm(to, { force: true });
  try {
    await fsp.link(from, to);
  } catch {
    await fsp.copyFile(from, to);
  }
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
    if (await fileExists(localPath)) return localPath;
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

  async ensureLocal(key: string, localPath: string) {
    if (await fileExists(localPath)) return localPath;
    const { client, sdk } = await this.s3();
    const res = await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
    if (!res.Body) throw new Error(`storage object missing: ${key}`);
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    const tmp = `${localPath}.part`;
    await pipeline(res.Body as Readable, fs.createWriteStream(tmp));
    await fsp.rename(tmp, localPath);
    return localPath;
  }

  async exists(key: string) {
    const { client, sdk } = await this.s3();
    try {
      await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return true;
    } catch {
      return false;
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
}

async function fileExists(file: string) {
  try {
    return (await fsp.stat(file)).size > 0;
  } catch {
    return false;
  }
}

export function createStorage(config: Config, paths: Paths): Storage {
  if (config.STORAGE_DRIVER === "s3") return new S3Storage(config, config.S3_BUCKET!, config.S3_PREFIX ?? "");
  return new LocalStorage(config.STORAGE_LOCAL_DIR ?? paths.storage);
}

// ---------- key helpers ----------
export const keys = {
  upload: (id: string, ext: string) => `uploads/${id}${ext}`,
  source: (projectId: string, ext: string) => `projects/${projectId}/source${ext}`,
  // one file per render generation: a stale render can never overwrite a newer one's output
  clip: (projectId: string, clipId: string, gen = 0) => `projects/${projectId}/clips/${clipId}${gen ? `.${gen}` : ""}.mp4`,
  thumb: (projectId: string, clipId: string, gen = 0) => `projects/${projectId}/clips/${clipId}${gen ? `.${gen}` : ""}.jpg`,
  /** a user's intro/outro as uploaded; assets are immutable, so the key never changes */
  bumper: (id: string, ext: string) => `bumpers/${id}/source${ext}`,
  /** derived cache: the bumper normalised to the render canvas (`variant` names canvas + encode version) */
  bumperNorm: (id: string, variant: string) => `bumpers/${id}/norm.${variant}.mp4`,
  projectPrefix: (projectId: string) => `projects/${projectId}`,
};
