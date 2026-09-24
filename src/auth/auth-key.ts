import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

export const AUTH_KEY_FILE_NAME = "auth-secret.key";

interface TokenRow {
  character_id: number;
  access_token: string;
  refresh_token: string;
}

interface DecryptedRow {
  characterId: number;
  access: string;
  refresh: string;
}

/**
 * Legacy key derivation (pre-persistent-key installs). The passphrase mixes
 * hostname, platform, and architecture, so the key only reproduces on the
 * machine the tokens were stored on. Used solely to verify and re-encrypt
 * stored tokens during migration — never for new encryption.
 */
export function deriveLegacyAuthKey(): Buffer {
  const passphrase = `${os.hostname()}-${os.platform()}-${os.arch()}`;
  const salt = crypto.createHash("sha256").update(os.hostname()).digest().subarray(0, KEY_LENGTH);
  return crypto.pbkdf2Sync(passphrase, salt, 100000, KEY_LENGTH, "sha256");
}

/** Read raw 32-byte key material; null if the file is missing, unreadable, or the wrong length. */
export function readAuthKeyFile(keyFile: string): Buffer | null {
  try {
    const key = fs.readFileSync(keyFile);
    return key.length === KEY_LENGTH ? key : null;
  } catch {
    return null;
  }
}

/**
 * Atomically persist raw key material (temp file + rename, atomic on both
 * POSIX and NTFS) so a crash can never leave a truncated key file. Mode
 * 0o600 where the platform honors it; on Windows the mode is a no-op, which
 * is acceptable because the file lives in the per-user profile directory.
 */
export function writeAuthKeyFile(keyFile: string, key: Buffer): void {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const tmp = `${keyFile}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, keyFile);
}

export function encryptValue(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptValue(key: Buffer, ciphertext: string): string {
  const [ivB64, tagB64, encB64] = ciphertext.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
}

/** Decrypt every stored token with a candidate key; null if any value fails. */
function decryptAllRows(rows: TokenRow[], key: Buffer): DecryptedRow[] | null {
  const out: DecryptedRow[] = [];
  for (const row of rows) {
    try {
      out.push({
        characterId: row.character_id,
        access: decryptValue(key, row.access_token),
        refresh: decryptValue(key, row.refresh_token),
      });
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * Resolve the key used to encrypt EVE SSO tokens in auth.db.
 *
 * Steady state: a valid key file whose key decrypts every stored row.
 * Legacy install (rows exist, no valid key file): first verify every row
 * decrypts with the legacy hostname-derived key, then re-encrypt all rows
 * with a new persistent random key. The key file is written before the
 * database rewrite, so the only transient state a crash can leave is "key
 * file present, rows still legacy-encrypted"; re-running this function on
 * the next start re-encrypts with the existing key file (self-heal). A crash
 * can never leave rows re-encrypted with a key whose file is missing.
 *
 * If no key can decrypt the stored rows, throws: no data is ever rewritten
 * or discarded.
 */
export function resolveAuthEncryptionKey(db: Database.Database, keyFile: string): Buffer {
  const rows = db
    .prepare("SELECT character_id, access_token, refresh_token FROM auth_tokens")
    .all() as TokenRow[];

  const persistent = readAuthKeyFile(keyFile);
  if (persistent && (rows.length === 0 || decryptAllRows(rows, persistent) !== null)) {
    return persistent;
  }

  if (rows.length > 0) {
    const legacyDecrypted = decryptAllRows(rows, deriveLegacyAuthKey());
    if (legacyDecrypted) {
      const key = persistent ?? crypto.randomBytes(KEY_LENGTH);
      if (!persistent) writeAuthKeyFile(keyFile, key);
      reEncryptTokenRows(db, legacyDecrypted, key);
      process.stderr.write(
        `Galaxy auth: migrated ${legacyDecrypted.length} stored token set(s) from the legacy hostname-derived key to ${keyFile}\n`
      );
      return key;
    }
    throw new Error(
      `Galaxy cannot decrypt the stored EVE SSO tokens in auth.db with either the ` +
      `persistent key (${keyFile}) or the legacy hostname-derived key. The database ` +
      `and key file may come from different installations, or the key file is damaged. ` +
      `No data was modified. Restore a consistent backup of the .eve-sde directory, ` +
      `or delete the affected character rows and re-authenticate via esi_login.`
    );
  }

  const key = crypto.randomBytes(KEY_LENGTH);
  writeAuthKeyFile(keyFile, key);
  return key;
}

function reEncryptTokenRows(db: Database.Database, decrypted: DecryptedRow[], key: Buffer): void {
  const update = db.prepare(
    "UPDATE auth_tokens SET access_token = ?, refresh_token = ? WHERE character_id = ?"
  );
  const tx = db.transaction(() => {
    for (const row of decrypted) {
      update.run(encryptValue(key, row.access), encryptValue(key, row.refresh), row.characterId);
    }
  });
  tx();
}
