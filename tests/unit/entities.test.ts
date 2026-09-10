import { describe, it, expect } from "vitest";
import { getStateDatabase } from "../../src/persistence.js";
import { Ledger } from "../../src/ledger.js";
import { EntityIndex, extractEntityRefs, discoverSources } from "../../src/entities.js";

const planet = { type: "planet", id: "40371521" };
const base = { namespace: "wormlife", kind: "planet_resource_density", key: "density", source_type: "user_measured", observed_at: "2026-09-10T12:00:00Z", payload: { planet_id: 40371521, solar_system_id: 31000398, character_id: 641570826, density: 0.73 } };
describe("generic entity relationships", () => {
  it("indexes stable IDs without changing payloads; preserves large IDs and ignores names and ambiguous fields", () => {
    const ledger = new Ledger(getStateDatabase()), index = new EntityIndex(ledger.db);
    const record = ledger.store(base);
    expect(record.payload).toEqual(base.payload);
    expect(index.related({ namespace: "wormlife", entity_refs: [planet] }).related_records[0]).toMatchObject({ id: record.id, source_type: "user_measured", source: "wormlife_record", relation: "same_planet", is_current: true });
    expect(extractEntityRefs({ name: "J154212 VIII", owner_id: 12, id: 99, structure_id: "9007199254740993", location_id: 9007199254740992, nested: [{ typeID: 34 }] })).toEqual([{ type: "structure", id: "9007199254740993" }, { type: "type", id: "34" }]);
    expect(index.related({ namespace: "other", entity_refs: [planet] }).related_records).toEqual([]);
    expect(index.related({ namespace: "wormlife", entity_refs: [{ ...planet, id: "40371522" }] }).related_records).toEqual([]);
    expect(extractEntityRefs({ observer_character_id: 42, fortizar_location_id: "1039342434314", blueprint_type_id: 34 })).toEqual([
      { type: "character", id: "42" }, { type: "location", id: "1039342434314" }, { type: "type", id: "34" },
    ]);
  });
  it("prefers current revisions and pages history without inferring supersession from dates", () => {
    const ledger = new Ledger(getStateDatabase()), index = new EntityIndex(ledger.db);
    const old = ledger.store({ ...base, observed_at: "2026-09-07T12:00:00Z" });
    const latest = ledger.store(base, old.id);
    expect(index.related({ namespace: "wormlife", entity_refs: [planet] }).related_records.map(r => r.id)).toEqual([latest.id]);
    const first = index.related({ namespace: "wormlife", entity_refs: [planet], current_only: false, limit: 1 });
    expect(first.related_records[0].id).toBe(latest.id); expect(first.nextOffset).toBe(1);
    expect(index.related({ namespace: "wormlife", entity_refs: [planet], current_only: false, offset: 1 }).related_records[0]).toMatchObject({ id: old.id, is_current: false });
    expect(ledger.get({ namespace: "wormlife", id: old.id })?.id).toBe(old.id);
  });
  it("supports open entity types, compound intersections and non-PI records", () => {
    const ledger = new Ledger(getStateDatabase()), index = new EntityIndex(ledger.db);
    ledger.store({ namespace: "wormlife", kind: "inventory", payload: { structure_id: "1000000000001", type_id: 34 }, entity_refs: [{ type: "custom_entity", id: "42" }] });
    const refs = [{ type: "structure", id: "1000000000001" }, { type: "type", id: "34" }];
    expect(index.related({ namespace: "wormlife", entity_refs: refs, match: "all" }).related_records).toHaveLength(1);
    expect(index.related({ namespace: "wormlife", entity_refs: [...refs, { type: "character", id: "1" }], match: "all" }).related_records).toHaveLength(0);
    expect(index.related({ namespace: "wormlife", entity_refs: [{ type: "custom_entity", id: "42" }] }).related_records).toHaveLength(1);
  });
  it("never backfills existing records during open/read and keeps a correction atomic on invalid refs", () => {
    const ledger = new Ledger(getStateDatabase()), index = new EntityIndex(ledger.db);
    const record = ledger.store(base);
    ledger.db.prepare("DELETE FROM record_entity_refs WHERE record_id=?").run(record.id);
    ledger.db.prepare("DELETE FROM record_entity_metadata WHERE record_id=?").run(record.id);
    expect(ledger.get({ namespace: "wormlife", id: record.id })).toMatchObject({ entity_indexed: false, entity_refs: [] });
    expect(index.related({ namespace: "wormlife", entity_refs: [planet] }).related_records).toHaveLength(0);
    expect(() => ledger.store({ ...base, entity_refs: [{ type: "planet", id: -1 }] }, record.id)).toThrow();
    expect(ledger.history({ namespace: "wormlife", id: record.id })).toHaveLength(1);
  });
  it("bounds results for large multi-entity records without exceeding SQLite expression depth", () => {
    const ledger = new Ledger(getStateDatabase()), index = new EntityIndex(ledger.db);
    const refs = Array.from({ length: 1000 }, (_, i) => ({ type: "type", id: String(i + 1) }));
    for (let i = 0; i < 12; i++) ledger.store({ namespace: "wormlife", kind: "inventory", payload: {}, entity_refs: refs });
    const result = index.related({ namespace: "wormlife", entity_refs: refs });
    expect(result.related_records).toHaveLength(10); expect(result.nextOffset).toBe(10);
    expect(result.related_records[0]).not.toHaveProperty("payload");
  });
  it("discovers logical sources and typed record targets without fetching or crossing namespaces", () => {
    const ledger = new Ledger(getStateDatabase());
    const target = ledger.store({ ...base, kind: "pi_colony_snapshot", key: "snapshot" });
    const record = ledger.store({ ...base, related_galaxy: [{ relation: "related_colony_history", namespace: "wormlife", kind: "pi_colony_snapshot", entity_refs: [planet] }] });
    const result = ledger.discover(record, { include_related: true }) as any;
    expect(result.available_sources).toEqual(expect.arrayContaining([expect.objectContaining({ subsystem: "esi_planetary_colony", resolved: false, arguments: { character_id: 641570826, planet_id: 40371521 } })]));
    expect(result.related_targets[0].related_records[0].id).toBe(target.id);
    expect(ledger.discover(record, { include_related: true, relation_depth: 0 })).not.toHaveProperty("available_sources");
    expect(discoverSources([{ type: "character", id: "1" }, { type: "planet", id: "2" }, { type: "planet", id: "3" }]).some(s => s.subsystem === "esi_planetary_colony")).toBe(false);
  });
});
