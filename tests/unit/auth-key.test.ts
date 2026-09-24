import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let sdeDir = "";

vi.mock("../../src/database.js", () => ({
  getSdeDir: () => sdeDir,
}));

import {
  storeTokens,
  getTokens,
  getCurrentCharacterId,
  setCurrentCharacterId,
  closeAuthDb,
} from "../../src/auth/tokens.js";
import type { OAuthTokens, CharacterInfo } from "../../src/auth/oauth.js";
import {
  AUTH_KEY_FILE_NAME,
  deriveLegacyAuthKey,
  decryptValue,
  encryptValue,
} from "../../src/auth/auth-key.js";

const keyFile = () => path.join(sdeDir, AUTH_KEY_FILE_NAME);
const dbPath = () => path.join(sdeDir, "auth.db");

beforeEach(() => {
  closeAuthDb();
  sdeDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-sde-auth-key-"));
});

afterEach(() => {
  closeAuthDb();
  fs.rmSync(sdeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeTokens(overrides?: Partial<OAuthTokens>): OAuthTokens {
  return {
    accessToken: "access-" + Math.random().toString(36).slice(2),
    refreshToken: "refresh-" + Math.random().toString(36).slice(2),
    expiresAt: new Date(Date.now() + 3600000),
    ...overrides,
  };
}

function makeCharacter(id: number, name: string, scopes = "esi-test.v1"): CharacterInfo {
  return { characterId: id, characterName: name, scopes };
}

interface SeedRow {
  id: number;
  name: string;
  access: string;
  refresh: string;
  expiresAt?: string;
  scopes?: string;
}

function openRawDb(): Database.Database {
  const db = new Database(dbPath());
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
  `);
  return db;
}

/** Seed rows encrypted with the legacy hostname-derived key (simulates a pre-migration install). */
function seedLegacyRows(rows: SeedRow[]): void {
  const db = openRawDb();
  const key = deriveLegacyAuthKey();
  insertRows(db, rows, key);
  db.close();
}

/** Seed rows encrypted with an explicit key (simulates arbitrary/corrupted ciphertext). */
function seedRawRows(rows: SeedRow[], key: Buffer): void {
  const db = openRawDb();
  insertRows(db, rows, key);
  db.close();
}

function insertRows(db: Database.Database, rows: SeedRow[], key: Buffer): void {
  const insert = db.prepare(
    `INSERT INTO auth_tokens
     (character_id, character_name, access_token, refresh_token, expires_at, scopes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.name,
      encryptValue(key, row.access),
      encryptValue(key, row.refresh),
      row.expiresAt ?? "2026-06-01T00:00:00.000Z",
      row.scopes ?? "esi-test.v1",
      "2026-06-01T00:00:00.000Z"
    );
  }
}

function readRawRows(): Array<Record<string, unknown>> {
  const db = new Database(dbPath(), { readonly: true });
  const rows = db
    .prepare("SELECT * FROM auth_tokens ORDER BY character_id")
    .all() as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

describe("new installation", () => {
  it("creates a persistent key file on first use and reuses it on later starts", () => {
    const tokens = makeTokens();
    storeTokens(tokens, makeCharacter(1, "Alice"));

    expect(fs.existsSync(keyFile())).toBe(true);
    const keyBefore = fs.readFileSync(keyFile());
    expect(keyBefore).toHaveLength(32);

    // Simulate a process restart: close the module state and read again.
    closeAuthDb();
    const result = getTokens(1);
    expect(result!.accessToken).toBe(tokens.accessToken);
    expect(result!.refreshToken).toBe(tokens.refreshToken);
    expect(fs.readFileSync(keyFile())).toEqual(keyBefore);
  });

  it("does not encrypt fresh tokens with the legacy hostname-derived key", () => {
    const tokens = makeTokens({ accessToken: "fresh-secret-token" });
    storeTokens(tokens, makeCharacter(2, "Bob"));

    const raw = readRawRows();
    expect(raw[0].access_token).not.toBe("fresh-secret-token");
    expect(() => decryptValue(deriveLegacyAuthKey(), raw[0].access_token as string)).toThrow();
  });
});

describe("persistent key across hosts", () => {
  it("decrypts tokens under a simulated hostname change once the persistent key exists", () => {
    const tokens = makeTokens();
    storeTokens(tokens, makeCharacter(3, "Carol"));
    expect(fs.existsSync(keyFile())).toBe(true);

    vi.spyOn(os, "hostname").mockReturnValue("galaxy-0");
    closeAuthDb();

    const result = getTokens(3);
    expect(result!.accessToken).toBe(tokens.accessToken);
    expect(result!.refreshToken).toBe(tokens.refreshToken);
  });
});

describe("legacy migration", () => {
  it("migrates hostname-derived tokens to the persistent key on first access", () => {
    const spec: SeedRow[] = [
      { id: 101, name: "Dana", access: "legacy-access-101", refresh: "legacy-refresh-101" },
      { id: 102, name: "Eli", access: "legacy-access-102", refresh: "legacy-refresh-102" },
    ];
    seedLegacyRows(spec);
    expect(fs.existsSync(keyFile())).toBe(false);
    const before = readRawRows();

    const result = getTokens(101);
    expect(result!.accessToken).toBe("legacy-access-101");
    expect(result!.refreshToken).toBe("legacy-refresh-101");

    expect(fs.existsSync(keyFile())).toBe(true);
    const fileKey = fs.readFileSync(keyFile());
    expect(fileKey).toHaveLength(32);

    const after = readRawRows();
    // Every row was re-encrypted (GCM IVs are random, so ciphertexts differ).
    expect(after).not.toEqual(before);
    // New ciphertexts decrypt with the key file and not with the legacy key.
    for (const specRow of spec) {
      const row = after.find((r) => r.character_id === specRow.id)!;
      expect(decryptValue(fileKey, row.access_token as string)).toBe(specRow.access);
      expect(decryptValue(fileKey, row.refresh_token as string)).toBe(specRow.refresh);
      expect(() => decryptValue(deriveLegacyAuthKey(), row.access_token as string)).toThrow();
    }
  });

  it("preserves every character, its metadata, and unrelated rows", () => {
    const spec: SeedRow[] = [
      { id: 201, name: "Main", access: "a-201", refresh: "r-201", expiresAt: "2026-01-02T03:04:05.000Z", scopes: "scope-one" },
      { id: 202, name: "Alt", access: "a-202", refresh: "r-202", expiresAt: "2026-02-03T04:05:06.000Z", scopes: "scope-two" },
      { id: 203, name: "Third", access: "a-203", refresh: "r-203" },
    ];
    seedLegacyRows(spec);
    const db = openRawDb();
    db.prepare("INSERT INTO config (key, value) VALUES ('current_character_id', '202')").run();
    db.close();

    expect(getCurrentCharacterId()).toBe(202);
    for (const row of spec) {
      const result = getTokens(row.id)!;
      expect(result.characterId).toBe(row.id);
      expect(result.characterName).toBe(row.name);
      expect(result.accessToken).toBe(row.access);
      expect(result.refreshToken).toBe(row.refresh);
      expect(result.expiresAt.toISOString()).toBe((row.expiresAt ?? "2026-06-01T00:00:00.000Z"));
      expect(result.scopes).toBe(row.scopes ?? "esi-test.v1");
    }
    // The config row is untouched by the migration.
    expect(getCurrentCharacterId()).toBe(202);
  });

  it("does not re-run legacy migration when the persistent key file already exists", () => {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile(), key);
    seedRawRows(
      [{ id: 301, name: "Persistent", access: "persisted-access", refresh: "persisted-refresh" }],
      key
    );

    // A different hostname would make the legacy key differ — success proves
    // the persistent key file alone drives decryption.
    vi.spyOn(os, "hostname").mockReturnValue("some-other-host");
    const result = getTokens(301);
    expect(result!.accessToken).toBe("persisted-access");
    expect(result!.refreshToken).toBe("persisted-refresh");
    expect(fs.readFileSync(keyFile())).toEqual(key);
  });

  it("self-heals a crash between the key-file write and the database rewrite", () => {
    // Key file was persisted, but the process died before re-encrypting rows.
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile(), key);
    seedLegacyRows([{ id: 401, name: "Crashed", access: "crash-access", refresh: "crash-refresh" }]);

    const result = getTokens(401);
    expect(result!.accessToken).toBe("crash-access");

    // Rows were re-encrypted with the pre-existing key file, not a new key.
    expect(fs.readFileSync(keyFile())).toEqual(key);
    const row = readRawRows()[0];
    expect(decryptValue(key, row.access_token as string)).toBe("crash-access");
  });
});

describe("failed migration", () => {
  it("aborts without touching the database or creating a key file", () => {
    // Rows encrypted with a key this install cannot derive (e.g. auth.db
    // copied from another host without migrating there first).
    seedRawRows(
      [{ id: 501, name: "Orphan", access: "orphan-access", refresh: "orphan-refresh" }],
      crypto.randomBytes(32)
    );
    const before = readRawRows();

    expect(() => getTokens(501)).toThrow(/cannot decrypt/);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(readRawRows()).toEqual(before);

    // A retry re-runs the protocol cleanly instead of hitting stale state.
    expect(() => getTokens(501)).toThrow(/cannot decrypt/);
    expect(readRawRows()).toEqual(before);
  });

  it("aborts when a corrupt key file exists and legacy decryption also fails", () => {
    fs.writeFileSync(keyFile(), crypto.randomBytes(16)); // wrong length
    seedRawRows(
      [{ id: 601, name: "Damaged", access: "damaged-access", refresh: "damaged-refresh" }],
      crypto.randomBytes(32)
    );

    expect(() => getTokens(601)).toThrow(/cannot decrypt/);
    // The corrupt file is neither silently regenerated nor used.
    expect(fs.readFileSync(keyFile())).toHaveLength(16);
    expect(readRawRows()[0].access_token).toBeTruthy();
  });
});

describe("key file reuse", () => {
  it("keeps the existing key file when all characters are removed", () => {
    const tokens = makeTokens();
    storeTokens(tokens, makeCharacter(701, "Temp"));
    const keyBefore = fs.readFileSync(keyFile());

    closeAuthDb();
    // Re-open (key file present, rows present) then delete the character.
    expect(getTokens(701)!.accessToken).toBe(tokens.accessToken);
    const db = new Database(dbPath());
    db.prepare("DELETE FROM auth_tokens WHERE character_id = ?").run(701);
    db.close();

    closeAuthDb();
    // Re-open with zero rows: the key file must be reused, not regenerated.
    expect(getTokens(701)).toBeNull();
    expect(fs.readFileSync(keyFile())).toEqual(keyBefore);
  });

  it("sets the current character id alongside migrated rows", () => {
    seedLegacyRows([{ id: 801, name: "Solo", access: "solo-access", refresh: "solo-refresh" }]);
    setCurrentCharacterId(801);
    expect(getCurrentCharacterId()).toBe(801);
    expect(getTokens(801)!.accessToken).toBe("solo-access");
  });
});
