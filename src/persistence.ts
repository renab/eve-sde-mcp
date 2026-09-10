import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

let state: Database.Database | undefined;
export function openStateDatabase(filename: string): Database.Database {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS esi_cache (
      cache_key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, expires_at INTEGER NOT NULL,
      entry TEXT NOT NULL CHECK(json_valid(entry))
    );
    CREATE TABLE IF NOT EXISTS esi_backoff (key TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS structure_resolutions (
      structure_id TEXT NOT NULL, character_id INTEGER NOT NULL, payload TEXT,
      fetched_at TEXT, expires_at INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_error_at TEXT,
      PRIMARY KEY(structure_id,character_id)
    );
    CREATE TABLE IF NOT EXISTS keep_warm_subscriptions (
      id TEXT PRIMARY KEY, dataset TEXT NOT NULL, subject_key TEXT NOT NULL,
      params_json TEXT NOT NULL CHECK(json_valid(params_json)), enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, last_considered_at TEXT, last_refresh_attempt_at TEXT,
      last_refresh_success_at TEXT, last_error TEXT, status TEXT NOT NULL DEFAULT 'subscribed',
      jitter_ms INTEGER NOT NULL,
      UNIQUE(dataset,subject_key,params_json)
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, kind TEXT NOT NULL, key TEXT,
      observed_at TEXT, created_at TEXT NOT NULL, source_type TEXT, source_ref TEXT,
      supersedes_id TEXT UNIQUE REFERENCES records(id), status TEXT,
      tags TEXT NOT NULL CHECK(json_valid(tags)), payload TEXT NOT NULL CHECK(json_valid(payload))
    );
    CREATE INDEX IF NOT EXISTS records_lookup ON records(namespace,kind,key);
    CREATE INDEX IF NOT EXISTS records_observed ON records(observed_at);
    CREATE TABLE IF NOT EXISTS record_entity_refs (
      record_id TEXT NOT NULL REFERENCES records(id), entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, name TEXT, PRIMARY KEY(record_id,entity_type,entity_id)
    );
    CREATE INDEX IF NOT EXISTS entity_records_lookup ON record_entity_refs(entity_type,entity_id,record_id);
    CREATE TABLE IF NOT EXISTS record_entity_metadata (
      record_id TEXT PRIMARY KEY REFERENCES records(id),
      related_galaxy TEXT NOT NULL CHECK(json_valid(related_galaxy))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED, text, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, from_key TEXT NOT NULL,
      relation TEXT NOT NULL, to_key TEXT NOT NULL, observed_at TEXT, created_at TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload))
    );
    CREATE INDEX IF NOT EXISTS relationships_from ON relationships(namespace,from_key,relation);
    CREATE INDEX IF NOT EXISTS relationships_to ON relationships(namespace,to_key,relation);
    CREATE TABLE IF NOT EXISTS query_usage (
      namespace TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, elapsed_ms REAL NOT NULL,
      PRIMARY KEY(namespace,kind)
    );
  `);
  return db;
}
export function getStateDatabase(): Database.Database {
  return state ??= openStateDatabase(process.env.GALAXY_STATE_DB ?? path.join(os.homedir(), ".eve-sde", "galaxy-state.db"));
}
export function closeStateDatabase(): void { state?.close(); state = undefined; }
