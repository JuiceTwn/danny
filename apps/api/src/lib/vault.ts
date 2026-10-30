import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Application-level encryption for everything a user writes to Danny.
 *
 * - AES-256-GCM, so tampering is detected, not just hidden.
 * - Each workspace gets its own key, derived (HKDF) from a master key that lives only in the
 *   server's environment. The database never holds the key, so a stolen dump or backup is unreadable.
 * - The workspace id is also bound in as authenticated data, so a blob copied into another
 *   workspace's row fails to open instead of being readable there.
 * - Blobs carry a key version. To rotate, add a new key to DATA_KEYS: new writes use it, old data
 *   still opens with the old one.
 *
 * Blob layout: [1 byte key version][12 byte iv][16 byte auth tag][ciphertext]
 */
export class Vault {
  private masters = new Map<number, Buffer>();
  private derived = new Map<string, Buffer>();
  readonly currentVersion: number;

  /** spec: "1:<base64 of 32 random bytes>,2:<...>". Generate a key with: openssl rand -base64 32 */
  constructor(spec: string) {
    for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
      const [v, b64] = part.split(":");
      const version = Number(v);
      const key = Buffer.from(b64 ?? "", "base64");
      if (!Number.isInteger(version) || version < 1 || version > 255) throw new Error("DATA_KEYS: version must be 1-255");
      if (key.length !== 32) throw new Error(`DATA_KEYS: key ${v} must be 32 bytes (openssl rand -base64 32)`);
      this.masters.set(version, key);
    }
    if (this.masters.size === 0) throw new Error("DATA_KEYS is required (format 1:<base64 32 bytes>)");
    this.currentVersion = Math.max(...this.masters.keys());
  }

  private keyFor(version: number, workspaceId: string) {
    const id = `${version}:${workspaceId}`;
    let k = this.derived.get(id);
    if (!k) {
      const master = this.masters.get(version);
      if (!master) throw new Error(`no key for version ${version}`);
      k = Buffer.from(hkdfSync("sha256", master, Buffer.from(workspaceId), Buffer.from("danny/workspace-key/v1"), 32));
      if (this.derived.size > 5000) this.derived.clear();
      this.derived.set(id, k);
    }
    return k;
  }

  seal(workspaceId: string, plaintext: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.keyFor(this.currentVersion, workspaceId), iv);
    c.setAAD(Buffer.from(workspaceId));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from([this.currentVersion]), iv, c.getAuthTag(), ct]);
  }

  open(workspaceId: string, blob: Buffer): string {
    const version = blob[0];
    if (version === undefined || blob.length < 29) throw new Error("malformed encrypted value");
    const d = createDecipheriv("aes-256-gcm", this.keyFor(version, workspaceId), blob.subarray(1, 13));
    d.setAAD(Buffer.from(workspaceId));
    d.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([d.update(blob.subarray(29)), d.final()]).toString("utf8");
  }

  sealJson(workspaceId: string, value: unknown) {
    return this.seal(workspaceId, JSON.stringify(value));
  }
  openJson<T = unknown>(workspaceId: string, blob: Buffer): T {
    return JSON.parse(this.open(workspaceId, blob)) as T;
  }

  /** True when a blob was written with an older key and should be re-sealed. */
  isStale(blob: Buffer) {
    return blob[0] !== this.currentVersion;
  }
}
