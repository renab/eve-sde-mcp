import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/** Never log credential-tool arguments, including labels which can accidentally contain a key. */
export function redactSecrets(value: unknown): any {
  if (typeof value === "string") return value.replace(/\bnxm_[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const credentialTool = typeof obj.name === "string" && /^nexum_(add|update)_credential$/.test(obj.name);
  return Object.fromEntries(Object.entries(obj).map(([k,v]) => [k,
    /api.?key|authorization|password|secret|token/i.test(k) || (credentialTool && k === "arguments")
      ? "[REDACTED]" : redactSecrets(v)]));
}

/** Separate encrypted secret table; a random installation key, never hostname-derived. */
export class SecretStore {
  private key: Buffer;
  constructor(private db: Database.Database, keyFile: string) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (e: any) { if (e.code !== "EEXIST") throw new Error("Secret storage unavailable"); }
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error("Invalid secret storage key");
    db.exec("CREATE TABLE IF NOT EXISTS galaxy_secrets (id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL)");
  }
  put(id: string, value: string): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    this.db.prepare("INSERT OR REPLACE INTO galaxy_secrets VALUES (?,?)").run(id,
      Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"));
  }
  get(id: string): string {
    const row = this.db.prepare("SELECT ciphertext FROM galaxy_secrets WHERE id=?").get(id) as any;
    if (!row) throw new Error("Credential secret unavailable");
    const b = Buffer.from(row.ciphertext, "base64");
    const cipher = crypto.createDecipheriv("aes-256-gcm", this.key, b.subarray(0,12));
    cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(b.subarray(12,28));
    return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString("utf8");
  }
  remove(id: string): void { this.db.prepare("DELETE FROM galaxy_secrets WHERE id=?").run(id); }
}
