// Read-only audit. Never initializes/migrates the live database or edits records.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractEntityRefs } from "../dist/entities.js";

const filename = process.argv[2] ?? path.join(os.homedir(), ".eve-sde", "galaxy-state.db");
const output = process.argv[3];
if (!output) throw new Error("Usage: node scripts/audit-entity-backfill.mjs <database> <output.json>");
const db = new Database(filename, { readonly: true, fileMustExist: true });
const sde = new Database(path.join(os.homedir(), ".eve-sde", "eve.db"), { readonly: true, fileMustExist: true });
try {
  const hasIndex = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='record_entity_metadata'").get();
  const records = db.transaction(() => db.prepare(`SELECT r.*, NOT EXISTS (SELECT 1 FROM records n WHERE n.supersedes_id=r.id) is_current
    ${hasIndex ? ", EXISTS (SELECT 1 FROM record_entity_metadata m WHERE m.record_id=r.id) entity_indexed" : ", 0 entity_indexed"}
    FROM records r WHERE namespace='wormlife' ORDER BY kind,r.rowid`).all())();
  const characterNames = new Map();
  const learn = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith("character_id") && Number.isSafeInteger(child) && child > 0) {
        const name = value[key.replace(/_id$/, "")] ?? value[key.replace(/_id$/, "_name")];
        if (typeof name === "string") {
          const ids = characterNames.get(name) ?? new Set(); ids.add(String(child)); characterNames.set(name, ids);
        }
      }
      if (child && typeof child === "object") learn(child);
    }
  };
  for (const row of records) learn(JSON.parse(row.payload));
  const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI"];
  const manifest = records.map(row => {
    const payload = JSON.parse(row.payload);
    let direct = [], extractionError = null;
    try { direct = extractEntityRefs(payload); } catch (error) { extractionError = error.message; }
    const identities = [], resolved = [];
    const walk = (value, location = "payload") => {
      if (!value || typeof value !== "object") return;
      for (const [field, child] of Object.entries(value)) {
        const fieldPath = `${location}.${field}`;
        if (typeof child === "string" && /(?:name|system|planet|character|structure|location|type|owner|pilot|id|hull|item|hub)$/i.test(field)) {
          const candidate = { path: fieldPath, value: child.slice(0, 200) };
          identities.push(candidate);
          // Only typed system/type/planet names get exact SDE lookup, never fuzzy matching.
          const lookups = /^(solar_system_name|solarSystemName|system_name|systemName|system|solar_system|home_system|from_system|to_system|origin_system|destination_system|hub)$/.test(field)
            ? ["solar_system", "SELECT solarSystemID id FROM mapSolarSystems WHERE solarSystemName=?"]
            : /^(planet_name|planetName|planet)$/.test(field)
              ? ["planet", "SELECT itemID id FROM mapDenormalize WHERE itemName=? AND groupID=7"]
              : /^(type_name|typeName|hull|item)$/.test(field) ? ["type", "SELECT typeID id FROM invTypes WHERE typeName=?"] : null;
          if (lookups) {
            let lookupName = child, method = "exact_unique_sde";
            const match = lookups[0] === "planet" ? /^(.*) ([IVX]+)$/.exec(child) : null;
            if (match && roman.includes(match[2])) { lookupName = `${match[1]} ${roman.indexOf(match[2]) + 1}`; method = "roman_planet_ordinal_exact_sde"; }
            if (lookups[0] === "type" && child.endsWith(" Blueprint Copy")) { lookupName = child.replace(/ Blueprint Copy$/, " Blueprint"); method = "blueprint_copy_label_exact_sde"; }
            const matches = sde.prepare(lookups[1]).all(lookupName);
            if (matches.length === 1) resolved.push({ ...candidate, type: lookups[0], id: String(matches[0].id), method });
          }
          if (/^(character|character_name|pilot|observer_character|measured_by_character)$/.test(field)) {
            const ids = characterNames.get(child);
            if (ids?.size === 1) resolved.push({ ...candidate, type: "character", id: [...ids][0], method: "exact_unambiguous_corpus_name_id" });
          }
        }
        if (child && typeof child === "object") walk(child, fieldPath);
      }
    };
    walk(payload);
    // Planet -> parent system is static identity, not a current colony/ownership assertion.
    for (const ref of [...direct, ...resolved]) if (ref.type === "planet") {
      const parent = sde.prepare("SELECT solarSystemID FROM mapDenormalize WHERE itemID=? AND groupID=7").get(ref.id);
      if (parent?.solarSystemID) resolved.push({ type: "solar_system", id: String(parent.solarSystemID), method: "sde_planet_parent", path: `planet:${ref.id}` });
    }
    return { id: row.id, kind: row.kind, key: row.key, observed_at: row.observed_at, supersedes_id: row.supersedes_id,
      current: !!row.is_current, indexed: !!row.entity_indexed, source_type: row.source_type,
      record_sha256: createHash("sha256").update(JSON.stringify({ id: row.id, payload: row.payload, observed_at: row.observed_at,
        created_at: row.created_at, source_type: row.source_type, source_ref: row.source_ref, status: row.status, supersedes_id: row.supersedes_id, tags: row.tags })).digest("hex"),
      direct_refs: direct, deterministic_name_refs: resolved, identity_fields: identities, extraction_error: extractionError };
  });
  const kinds = [...new Set(manifest.map(r => r.kind))].map(kind => {
    const rows = manifest.filter(r => r.kind === kind);
    return { kind, total: rows.length, current: rows.filter(r => r.current).length, indexed: rows.filter(r => r.indexed).length,
      direct_id_records: rows.filter(r => r.direct_refs.length).length,
      exact_name_records: rows.filter(r => r.deterministic_name_refs.length).length,
      name_only_resolvable: rows.filter(r => !r.direct_refs.length && r.deterministic_name_refs.length).length,
      no_resolved_identity: rows.filter(r => !r.direct_refs.length && !r.deterministic_name_refs.length).length,
      entity_types: [...new Set(rows.flatMap(r => [...r.direct_refs, ...r.deterministic_name_refs].map(ref => ref.type)))].sort(),
      identity_paths: [...new Set(rows.flatMap(r => r.identity_fields.map(f => f.path.replace(/\.\d+(?=\.|$)/g, "[]"))))].sort() };
  });
  const audit = { generated_at: new Date().toISOString(), namespace: "wormlife", read_only: true, total: manifest.length,
    current: manifest.filter(r => r.current).length, kinds, manifest };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(audit, null, 2) + "\n");
  console.log(JSON.stringify({ output, total: audit.total, current: audit.current,
    kinds: kinds.map(({ identity_paths, ...kind }) => kind) }, null, 2));
} finally { db.close(); sde.close(); }
