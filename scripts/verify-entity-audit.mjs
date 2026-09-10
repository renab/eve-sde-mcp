// Exercises a proposed manifest only in an in-memory database. No live writes.
import Database from "better-sqlite3";
import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openStateDatabase } from "../dist/persistence.js";
import { EntityIndex, extractEntityRefs, discoverSources } from "../dist/entities.js";
const [filename, manifestFile] = process.argv.slice(2);
if (!filename || !manifestFile) throw new Error("Usage: node scripts/verify-entity-audit.mjs <live-db> <audit.json>");
const live = new Database(filename, { readonly: true, fileMustExist: true });
const memory = openStateDatabase(":memory:");
try {
  const audit = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const rows = live.prepare("SELECT * FROM records WHERE namespace='wormlife' ORDER BY rowid").all();
  const before = JSON.stringify(rows);
  const insert = memory.prepare("INSERT INTO records VALUES (@id,@namespace,@kind,@key,@observed_at,@created_at,@source_type,@source_ref,@supersedes_id,@status,@tags,@payload)");
  memory.transaction(() => { for (const row of rows) insert.run(row); })();
  const index = new EntityIndex(memory);
  let simulated = 0;
  for (const entry of audit.manifest) {
    const row = rows.find(r => r.id === entry.id);
    assert(row, `Missing audited record ${entry.id}`);
    const hash = createHash("sha256").update(JSON.stringify({ id: row.id, payload: row.payload, observed_at: row.observed_at,
      created_at: row.created_at, source_type: row.source_type, source_ref: row.source_ref, status: row.status, supersedes_id: row.supersedes_id, tags: row.tags })).digest("hex");
    assert.equal(hash, entry.record_sha256, `Record changed since audit: ${entry.id}`);
    const refs = extractEntityRefs({}, [...entry.direct_refs, ...entry.deterministic_name_refs].map(({ type, id }) => ({ type, id })));
    if (refs.length) { index.write(entry.id, refs, []); simulated++; }
  }
  assert.equal(JSON.stringify(memory.prepare("SELECT * FROM records ORDER BY rowid").all()), before, "Simulation must preserve every stored record field");
  const density = index.related({ namespace: "wormlife", entity_refs: [{ type: "solar_system", id: "31000398" }], kind: "planet_resource_density", limit: 50 });
  assert.equal(density.related_records.length, 8, "All eight current density records must join to J154212");
  const planet = index.related({ namespace: "wormlife", entity_refs: [{ type: "planet", id: "40371521" }], limit: 50 });
  assert(planet.related_records.some(r => r.kind === "planet_resource_density"));
  assert(planet.related_records.some(r => r.kind === "pi_colony_snapshot"));
  const eighth = planet.related_records.find(r => r.kind === "planet_resource_density");
  assert(discoverSources(index.metadata(eighth.id).entity_refs).some(source => source.subsystem === "esi_planetary_colony" && source.arguments.character_id === 641570826));
  assert.equal(index.related({ namespace: "wormlife", entity_refs: [{ type: "solar_system", id: "31002238" }], kind: "planet_resource_density" }).related_records.length, 0);
  console.log(JSON.stringify({ verified: true, live_writes: 0, simulated_records: simulated,
    density_records_for_correct_system: 8, planet_VIII_kinds: planet.related_records.map(r => r.kind),
    record_fields_unchanged: true, historical_backfill_still_requires_approval: true }, null, 2));
} finally { live.close(); memory.close(); }
