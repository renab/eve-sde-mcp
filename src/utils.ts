import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

const stmtCache = new WeakMap<Database.Database, { typeName: Statement; systemName: Statement }>();

function getStatements(db: Database.Database) {
  let stmts = stmtCache.get(db);
  if (!stmts) {
    stmts = {
      typeName: db.prepare("SELECT typeName FROM invTypes WHERE typeID = ?"),
      systemName: db.prepare("SELECT solarSystemName FROM mapSolarSystems WHERE solarSystemID = ?"),
    };
    stmtCache.set(db, stmts);
  }
  return stmts;
}

export function enrichTypeName(db: Database.Database, typeId: number): string {
  const row = getStatements(db).typeName.get(typeId) as { typeName: string } | undefined;
  return row?.typeName ?? `Unknown(${typeId})`;
}

/** Resolve only an exact numeric SDE type ID; unresolved values never get a synthetic display name. */
export function resolveTypeName(db: Database.Database, sourceTypeId: unknown): string | null {
  if (sourceTypeId === null || sourceTypeId === undefined) return null;
  let id: number | bigint;
  if (typeof sourceTypeId === "number") {
    if (!Number.isSafeInteger(sourceTypeId) || sourceTypeId < 1) return null;
    id = sourceTypeId;
  } else if (typeof sourceTypeId === "string" && /^(?:0|[1-9]\d{0,18})$/.test(sourceTypeId)) {
    let integer: bigint;
    try { integer = BigInt(sourceTypeId); } catch { return null; }
    if (integer < 1n || integer > 9_223_372_036_854_775_807n) return null;
    id = integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
  } else return null;

  const row = getStatements(db).typeName.get(id) as { typeName?: unknown } | undefined;
  const name = row?.typeName;
  if (typeof name !== "string" || [...name].length < 1 || [...name].length > 256 ||
      name.trim() !== name || !name.trim() || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
}

export function enrichSystemName(db: Database.Database, systemId: number): string {
  const row = getStatements(db).systemName.get(systemId) as { solarSystemName: string } | undefined;
  return row?.solarSystemName ?? `Unknown(${systemId})`;
}

export function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function escapeLike(input: string): string {
  return input.replace(/[%_\\]/g, "\\$&");
}

export function likeContains(input: string): string {
  return `%${escapeLike(input)}%`;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
