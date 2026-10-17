/**
 * Secrets at rest (provider API keys entered in Settings): AES-256-GCM with a key derived from
 * BETTER_AUTH_SECRET by HKDF, so one operator secret protects both sessions and stored keys. Losing
 * or rotating that secret makes stored keys unreadable; they are then ignored and the admin enters
 * them again (ai/providers.ts says so in the UI).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

const VERSION = "v1";

export function createSecretBox(secret: string, purpose = "provider-keys"): SecretBox {
  const key = Buffer.from(hkdfSync("sha256", secret, "reelsaw", purpose, 32));
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
    },
    decrypt(sealed) {
      const [v, b64] = sealed.split(":");
      if (v !== VERSION || !b64) throw new Error("unknown ciphertext format");
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 28) throw new Error("ciphertext too short");
      const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
