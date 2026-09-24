import path from "path";
import Database from "better-sqlite3";
import { getSdeDir } from "../database.js";
import type { OAuthTokens, CharacterInfo } from "./oauth.js";
import { AUTH_KEY_FILE_NAME, decryptValue, encryptValue, resolveAuthEncryptionKey } from "./auth-key.js";

export interface StoredCharacter {
  characterId: number;
  characterName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string;
}

let authDb: Database.Database | null = null;
let encryptionKey: Buffer | null = null;

function getAuthDb(): Database.Database {
  if (authDb) return authDb;

  const dbPath = path.join(getSdeDir(), "auth.db");

  // Resolve (and, for legacy installs, migrate to) the persistent auth key
  // before the database handle is considered usable. If resolution fails the
  // freshly opened handle is closed so the next call re-runs the protocol.
  let db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        character_id INTEGER PRIMARY KEY,
        character_name TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        scopes TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loyalty_point_balances (
        character_id INTEGER NOT NULL,
        corporation_id INTEGER NOT NULL,
        loyalty_points INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (character_id, corporation_id)
      );
      CREATE TABLE IF NOT EXISTS loyalty_point_snapshots (
        character_id INTEGER PRIMARY KEY,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loyalty_point_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id INTEGER NOT NULL,
        corporation_id INTEGER NOT NULL,
        delta INTEGER NOT NULL,
        previous_balance INTEGER NOT NULL,
        current_balance INTEGER NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loyalty_activity_character_time
        ON loyalty_point_activity (character_id, observed_at DESC);
    `);
    encryptionKey = resolveAuthEncryptionKey(db, path.join(getSdeDir(), AUTH_KEY_FILE_NAME));
  } catch (err) {
    db.close();
    throw err;
  }
  authDb = db;
  return authDb;
}

function getKey(): Buffer {
  if (!encryptionKey) throw new Error("Auth encryption key not initialized; open the auth database first");
  return encryptionKey;
}

function encrypt(plaintext: string): string {
  return encryptValue(getKey(), plaintext);
}

function decrypt(ciphertext: string): string {
  return decryptValue(getKey(), ciphertext);
}

export function storeTokens(tokens: OAuthTokens, character: CharacterInfo): void {
  const db = getAuthDb();
  db.prepare(
    `INSERT OR REPLACE INTO auth_tokens
     (character_id, character_name, access_token, refresh_token, expires_at, scopes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    character.characterId,
    character.characterName,
    encrypt(tokens.accessToken),
    encrypt(tokens.refreshToken),
    tokens.expiresAt.toISOString(),
    character.scopes
  );
}

export function getTokens(characterId: number): StoredCharacter | null {
  const db = getAuthDb();
  const row = db
    .prepare("SELECT * FROM auth_tokens WHERE character_id = ?")
    .get(characterId) as any;
  if (!row) return null;
  return {
    characterId: row.character_id,
    characterName: row.character_name,
    accessToken: decrypt(row.access_token),
    refreshToken: decrypt(row.refresh_token),
    expiresAt: new Date(row.expires_at),
    scopes: row.scopes,
  };
}

export function updateTokens(characterId: number, tokens: OAuthTokens): void {
  const db = getAuthDb();
  db.prepare(
    `UPDATE auth_tokens
     SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')
     WHERE character_id = ?`
  ).run(encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt.toISOString(), characterId);
}

export function removeTokens(characterId: number): void {
  getAuthDb().prepare("DELETE FROM auth_tokens WHERE character_id = ?").run(characterId);
}

export function listCharacters(): Array<{
  characterId: number;
  characterName: string;
  expiresAt: Date;
  scopes: string;
}> {
  const rows = getAuthDb()
    .prepare("SELECT character_id, character_name, expires_at, scopes FROM auth_tokens ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map((r) => ({
    characterId: r.character_id,
    characterName: r.character_name,
    expiresAt: new Date(r.expires_at),
    scopes: r.scopes,
  }));
}

export function getCurrentCharacterId(): number | null {
  const row = getAuthDb()
    .prepare("SELECT value FROM config WHERE key = 'current_character_id'")
    .get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

export function setCurrentCharacterId(characterId: number): void {
  getAuthDb()
    .prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('current_character_id', ?)")
    .run(characterId.toString());
}

export function getCurrentCharacter(): StoredCharacter | null {
  const currentId = getCurrentCharacterId();
  if (currentId) {
    const tokens = getTokens(currentId);
    if (tokens) return tokens;
  }
  // Fall back to most recently updated
  const row = getAuthDb()
    .prepare("SELECT character_id FROM auth_tokens ORDER BY updated_at DESC LIMIT 1")
    .get() as { character_id: number } | undefined;
  if (!row) return null;
  return getTokens(row.character_id);
}

export interface LoyaltyPointBalance {
  corporationId: number;
  loyaltyPoints: number;
}

export interface LoyaltyPointActivity {
  id: number;
  characterId: number;
  corporationId: number;
  delta: number;
  previousBalance: number;
  currentBalance: number;
  observedAt: string;
}

export function recordLoyaltyPointSnapshot(
  characterId: number,
  balances: LoyaltyPointBalance[],
  observedAt = new Date().toISOString()
): LoyaltyPointActivity[] {
  const db = getAuthDb();
  const record = db.transaction(() => {
    const previousRows = db
      .prepare(
        "SELECT corporation_id, loyalty_points FROM loyalty_point_balances WHERE character_id = ?"
      )
      .all(characterId) as Array<{ corporation_id: number; loyalty_points: number }>;
    const previous = new Map(previousRows.map((row) => [row.corporation_id, row.loyalty_points]));
    const current = new Map(balances.map((row) => [row.corporationId, row.loyaltyPoints]));
    const hasBaseline = Boolean(
      db.prepare("SELECT 1 FROM loyalty_point_snapshots WHERE character_id = ?").get(characterId)
    );
    const activity: LoyaltyPointActivity[] = [];

    if (hasBaseline) {
      const corporationIds = new Set([...previous.keys(), ...current.keys()]);
      const insert = db.prepare(
        `INSERT INTO loyalty_point_activity
         (character_id, corporation_id, delta, previous_balance, current_balance, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const corporationId of corporationIds) {
        const previousBalance = previous.get(corporationId) ?? 0;
        const currentBalance = current.get(corporationId) ?? 0;
        const delta = currentBalance - previousBalance;
        if (delta === 0) continue;
        const result = insert.run(
          characterId,
          corporationId,
          delta,
          previousBalance,
          currentBalance,
          observedAt
        );
        activity.push({
          id: Number(result.lastInsertRowid),
          characterId,
          corporationId,
          delta,
          previousBalance,
          currentBalance,
          observedAt,
        });
      }
    }

    db.prepare("DELETE FROM loyalty_point_balances WHERE character_id = ?").run(characterId);
    const upsert = db.prepare(
      `INSERT INTO loyalty_point_balances
       (character_id, corporation_id, loyalty_points, observed_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const balance of balances) {
      upsert.run(characterId, balance.corporationId, balance.loyaltyPoints, observedAt);
    }
    db.prepare(
      `INSERT INTO loyalty_point_snapshots (character_id, observed_at) VALUES (?, ?)
       ON CONFLICT(character_id) DO UPDATE SET observed_at = excluded.observed_at`
    ).run(characterId, observedAt);

    return activity;
  });

  return record();
}

export function listLoyaltyPointActivity(
  characterId: number,
  options?: { corporationId?: number; since?: string; limit?: number }
): LoyaltyPointActivity[] {
  let sql = `SELECT id, character_id, corporation_id, delta, previous_balance,
                    current_balance, observed_at
             FROM loyalty_point_activity WHERE character_id = ?`;
  const params: Array<number | string> = [characterId];
  if (options?.corporationId !== undefined) {
    sql += " AND corporation_id = ?";
    params.push(options.corporationId);
  }
  if (options?.since) {
    sql += " AND observed_at >= ?";
    params.push(options.since);
  }
  sql += " ORDER BY observed_at DESC, id DESC LIMIT ?";
  params.push(options?.limit ?? 100);

  const rows = getAuthDb().prepare(sql).all(...params) as Array<{
    id: number;
    character_id: number;
    corporation_id: number;
    delta: number;
    previous_balance: number;
    current_balance: number;
    observed_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    characterId: row.character_id,
    corporationId: row.corporation_id,
    delta: row.delta,
    previousBalance: row.previous_balance,
    currentBalance: row.current_balance,
    observedAt: row.observed_at,
  }));
}

export function closeAuthDb(): void {
  if (authDb) {
    authDb.close();
    authDb = null;
  }
  // Clear the cached key so a re-open re-resolves it (and re-runs any pending
  // migration) against whatever is currently on disk.
  encryptionKey = null;
}
