import Database from "better-sqlite3";
import fs from "node:fs";
import { applyEntityBackfill } from "../dist/entity-backfill.js";

const [flag, databaseFile, manifestFile, verificationFile, outputPrefix, expectedRecords, expectedSkips] = process.argv.slice(2);
if (flag !== "--apply-approved" || !outputPrefix || !/^\d+$/.test(expectedRecords ?? "") || !/^\d+$/.test(expectedSkips ?? ""))
  throw new Error("Usage: node scripts/apply-entity-backfill.mjs --apply-approved <db> <manifest.json> <verification.json> <output-prefix> <approved-count> <skip-count>");
const auditBytes = fs.readFileSync(manifestFile);
const verification = JSON.parse(fs.readFileSync(verificationFile, "utf8"));
const db = new Database(databaseFile, { fileMustExist: true });
db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
try {
  const result = applyEntityBackfill(db, auditBytes, verification, Number(expectedRecords), Number(expectedSkips),
    snapshot => fs.writeFileSync(`${outputPrefix}-before.json`, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" }));
  fs.writeFileSync(`${outputPrefix}-result.json`, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ ...result, skipped_ids: result.skipped_ids.length, inserted_ids: result.inserted_ids.length }, null, 2));
} finally { db.close(); }
