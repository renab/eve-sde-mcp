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
