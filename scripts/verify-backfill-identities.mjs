// Verify only the approved saved manifest. ESI calls use Galaxy's normal auth/cache discipline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { esiGetWithMetadata } from "../dist/auth/esi-client.js";

const [manifestFile, output] = process.argv.slice(2);
if (!manifestFile || !output) throw new Error("Usage: node scripts/verify-backfill-identities.mjs <approved-manifest.json> <verification.json>");
const manifestBytes = fs.readFileSync(manifestFile);
const audit = JSON.parse(manifestBytes);
const sde = new Database(path.join(os.homedir(), ".eve-sde", "eve.db"), { readonly: true, fileMustExist: true });
const live = new Database(path.join(os.homedir(), ".eve-sde", "galaxy-state.db"), { readonly: true, fileMustExist: true });
const checks = [], conflicts = [], colonies = [];
const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI"];
const normalizePlanet = name => name.replace(/ ([IVX]+)$/, (whole, numeral) => roman.includes(numeral) ? ` ${roman.indexOf(numeral) + 1}` : whole);
const normalizeBlueprint = name => name.replace(/ Blueprint Copy$/, " Blueprint");
const snapshots = new Map();
const read = async (endpoint, privateRead = false) => {
  if (!snapshots.has(endpoint)) snapshots.set(endpoint, await esiGetWithMetadata(endpoint,
    privateRead ? { characterId: 641570826, allowStale: false } : { public: true, allowStale: false }));
  return snapshots.get(endpoint);
};
try {
  const refs = new Map();
  for (const entry of audit.manifest) for (const ref of [...entry.direct_refs, ...entry.deterministic_name_refs]) {
    const key = `${ref.type}:${ref.id}`;
    const group = refs.get(key) ?? { type: ref.type, id: String(ref.id), candidates: [] };
    group.candidates.push(ref); refs.set(key, group);
  }
  for (const ref of refs.values()) {
    try {
      let staticIdentity, endpoint, privateRead = false;
      if (ref.type === "solar_system") {
        staticIdentity = sde.prepare("SELECT solarSystemID id,solarSystemName name FROM mapSolarSystems WHERE solarSystemID=?").get(ref.id);
        endpoint = `/universe/systems/${ref.id}/`;
      } else if (ref.type === "planet") {
        staticIdentity = sde.prepare("SELECT itemID id,itemName name,solarSystemID system_id FROM mapDenormalize WHERE itemID=? AND groupID=7").get(ref.id);
        endpoint = `/universe/planets/${ref.id}/`;
      } else if (ref.type === "type") {
        staticIdentity = sde.prepare("SELECT typeID id,typeName name FROM invTypes WHERE typeID=?").get(ref.id);
        endpoint = `/universe/types/${ref.id}/`;
      } else if (ref.type === "character") endpoint = `/characters/${ref.id}/`;
      else if (ref.type === "corporation") endpoint = `/corporations/${ref.id}/`;
      else if (ref.type === "structure") { endpoint = `/universe/structures/${ref.id}/`; privateRead = true; }
      else if (ref.type === "location") {
        staticIdentity = sde.prepare("SELECT stationID id,stationName name,solarSystemID system_id FROM staStations WHERE stationID=?").get(ref.id);
        if (staticIdentity) endpoint = `/universe/stations/${ref.id}/`;
        else {
          // Only use a structure endpoint when an explicit structure identity in this same approved corpus corroborates it.
          assert(refs.has(`structure:${ref.id}`), `Unclassified location ${ref.id}`);
          endpoint = `/universe/structures/${ref.id}/`; privateRead = true;
        }
      } else throw new Error(`No verification adapter for ${ref.type}`);
      if (["solar_system", "planet", "type"].includes(ref.type)) assert(staticIdentity, `ID absent from SDE: ${ref.type}:${ref.id}`);
      const snapshot = await read(endpoint, privateRead);
      const esi = snapshot.data;
      if (staticIdentity) {
        const staticName = ref.type === "planet" ? normalizePlanet(staticIdentity.name) : staticIdentity.name;
        const esiName = ref.type === "planet" ? normalizePlanet(esi.name) : esi.name;
        assert.equal(esiName, staticName, `ESI/SDE name mismatch for ${ref.type}:${ref.id}`);
        if (staticIdentity.system_id) assert.equal(esi.system_id, staticIdentity.system_id, `ESI/SDE parent mismatch for ${ref.type}:${ref.id}`);
      }
      if (ref.type === "planet") assert.equal(String(esi.planet_id), ref.id);
      if (ref.type === "solar_system") assert.equal(String(esi.system_id), ref.id);
      if (ref.type === "type") assert.equal(String(esi.type_id), ref.id);
      for (const candidate of ref.candidates) {
        if (!candidate.value) continue;
        const expected = ref.type === "planet" ? normalizePlanet(candidate.value)
          : ref.type === "type" ? normalizeBlueprint(candidate.value) : candidate.value;
        const actual = ref.type === "planet" ? normalizePlanet(esi.name) : esi.name;
        assert.equal(actual, expected, `Audited name mismatch for ${ref.type}:${ref.id}`);
      }
      checks.push({ type: ref.type, id: ref.id, verified: true, name: esi.name,
        sde: staticIdentity ?? null, esi_identity: { name: esi.name, system_id: esi.system_id ?? esi.solar_system_id ?? null, type_id: esi.type_id ?? null },
        cache: snapshot.metadata });
    } catch (error) { conflicts.push({ type: ref.type, id: ref.id, error: error.message }); }
  }
  // Independently verify each historical colony's recorded character/planet pair against today's ESI colony list.
  // This validates identity, not past density values or unobserved historical ownership changes.
  const colonyRows = audit.manifest.filter(entry => entry.kind === "pi_colony_snapshot");
  const byCharacter = new Map();
  for (const entry of colonyRows) {
    const row = live.prepare("SELECT payload FROM records WHERE id=? AND namespace=?").get(entry.id, audit.namespace);
    assert(row, `Missing colony record ${entry.id}`);
    const payload = JSON.parse(row.payload);
    const planet = entry.deterministic_name_refs.find(ref => ref.type === "planet");
    assert(planet, `No audited planet for ${entry.id}`);
    try {
      if (!byCharacter.has(payload.character_id)) byCharacter.set(payload.character_id,
        await esiGetWithMetadata(`/characters/${payload.character_id}/planets/`, { characterId: payload.character_id, allowStale: false }));
      const snapshot = byCharacter.get(payload.character_id);
      const colony = snapshot.data.find(colony => String(colony.planet_id) === String(planet.id));
      assert(colony, `Recorded colony not in current ESI list: ${payload.character_id}/${planet.id}`);
      const parent = sde.prepare("SELECT solarSystemID FROM mapDenormalize WHERE itemID=?").get(planet.id);
      assert.equal(colony.solar_system_id, parent.solarSystemID);
      colonies.push({ record_id: entry.id, character_id: payload.character_id, planet_id: String(planet.id),
        solar_system_id: colony.solar_system_id, verified: true, last_update: colony.last_update, cache: snapshot.metadata });
    } catch (error) { conflicts.push({ record_id: entry.id, error: error.message }); }
  }
  const result = { verified_at: new Date().toISOString(), namespace: audit.namespace,
    manifest_sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    all_verified: conflicts.length === 0, checks, colonies, conflicts,
    note: "SDE supplies static identity; ESI independently confirms it. No density measurements, historical ownership, timestamps, or financial values are inferred from ESI." };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ verified_entities: checks.length, verified_colonies: colonies.length, conflicts, output }, null, 2));
  if (conflicts.length) process.exitCode = 1;
} finally { sde.close(); live.close(); }
