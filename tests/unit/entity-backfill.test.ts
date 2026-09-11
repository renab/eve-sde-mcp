import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getStateDatabase } from "../../src/persistence.js";
import { Ledger } from "../../src/ledger.js";
import { EntityIndex } from "../../src/entities.js";
import { applyEntityBackfill, recordFingerprint, type IdentityVerification } from "../../src/entity-backfill.js";

let ledger: Ledger, index: EntityIndex, audit: any, bytes: Buffer, evidence: IdentityVerification;
let firstId: string, secondId: string, skippedId: string;
const pack = () => {
  bytes = Buffer.from(JSON.stringify(audit));
  evidence.manifest_sha256 = createHash("sha256").update(bytes).digest("hex");
};
const apply = (backup: (value: unknown) => void = () => {}) => applyEntityBackfill(ledger.db, bytes, evidence, 2, 1, backup);
beforeEach(() => {
  ledger = new Ledger(getStateDatabase()); index = new EntityIndex(ledger.db);
  const input = { namespace: "wormlife", kind: "density", key: "one", source_type: "user_measured", observed_at: "2026-09-10T12:00:00Z", payload: { character_id: 42, type_id: 34 } };
  const first = ledger.store(input); firstId = first.id;
  const second = ledger.store({ ...input, payload: { ...input.payload, correction: true } }, first.id); secondId = second.id;
  const skipped = ledger.store({ namespace: "wormlife", kind: "policy", payload: { note: "ambiguous" } }); skippedId = skipped.id;
  audit = { namespace: "wormlife", manifest: [first, second, skipped].map(record => {
    const row = ledger.db.prepare("SELECT * FROM records WHERE id=?").get(record.id) as Record<string, unknown>;
    return { id: record.id, kind: record.kind, key: record.key, current: record.id !== first.id, record_sha256: recordFingerprint(row),
      direct_refs: record.id === skipped.id ? [] : [{ type: "character", id: "42" }],
      deterministic_name_refs: record.id === skipped.id ? [] : [{ type: "type", id: "34" }] };
  }) };
  ledger.db.exec("DELETE FROM record_entity_refs; DELETE FROM record_entity_metadata;");
  ledger.store({ namespace: "new_records", kind: "outside_scope", payload: { character_id: 99 } });
  evidence = { namespace: "wormlife", all_verified: true, verified_at: new Date().toISOString(), conflicts: [], manifest_sha256: "",
    checks: [{ type: "character", id: "42", name: "Pilot", verified: true }, { type: "type", id: "34", name: "Tritanium", sde: { name: "Tritanium" }, verified: true }] };
  pack();
});
afterEach(() => vi.restoreAllMocks());

it("indexes approved revisions only, retains history and original fields, and backs up before inserts", () => {
  const original = ledger.db.prepare("SELECT * FROM records ORDER BY id").all();
  const backup = vi.fn(() => expect(index.metadata(firstId).entity_indexed).toBe(false));
  const result = apply(backup);
  expect(result).toMatchObject({ inserted_records: 2, inserted_refs: 4, targeted_current: 1, targeted_historical: 1,
    record_fields_unchanged: true, non_target_indexes_unchanged: true, skipped_ids: [skippedId] });
  expect(backup).toHaveBeenCalledTimes(1);
  expect(ledger.db.prepare("SELECT * FROM records ORDER BY id").all()).toEqual(original);
  expect(index.metadata(skippedId).entity_indexed).toBe(false);
  expect(index.related({ namespace: "wormlife", entity_refs: [{ type: "character", id: "42" }] }).related_records.map(r => r.id)).toEqual([secondId]);
});

it("aborts if any audited content changed, without partially indexing earlier targets", () => {
  ledger.db.prepare("UPDATE records SET payload=? WHERE id=?").run('{"changed":true}', secondId);
  expect(() => apply()).toThrow("changed or missing");
  expect(index.metadata(firstId).entity_indexed).toBe(false);
});

it("requires matching verified evidence for every entity and exact approved counts", () => {
  evidence.checks.pop();
  expect(() => apply()).toThrow("No successful ESI verification");
  expect(index.metadata(firstId).entity_indexed).toBe(false);
  expect(() => applyEntityBackfill(ledger.db, bytes, evidence, 3, 0, () => {})).toThrow("approved record/skip counts");
});

it("rolls back all side-table writes if an insert fails", () => {
  const original = EntityIndex.prototype.write;
  let calls = 0;
  vi.spyOn(EntityIndex.prototype, "write").mockImplementation(function (this: EntityIndex, ...args) {
    if (++calls === 2) throw new Error("injected failure");
    return original.apply(this, args);
  });
  expect(() => apply()).toThrow("injected failure");
  expect(index.metadata(firstId).entity_refs).toEqual([]);
  expect(index.metadata(firstId).entity_indexed).toBe(false);
});

it("is idempotent and refuses conflicting existing metadata", () => {
  expect(apply().inserted_records).toBe(2);
  expect(apply()).toMatchObject({ inserted_records: 0, already_indexed: 2 });
  ledger.db.prepare("DELETE FROM record_entity_refs WHERE record_id=? AND entity_type='type'").run(firstId);
  expect(() => apply()).toThrow("Conflicting existing index");
});

it("preserves lifecycle changes caused by newer records outside the manifest", () => {
  const newer = ledger.store({ namespace: "wormlife", kind: "density", key: "one", payload: { character_id: 42, type_id: 35 } }, secondId);
  const refs = index.metadata(newer.id);
  expect(apply()).toMatchObject({ targeted_current: 0, targeted_historical: 2, lifecycle_changes_since_audit: [secondId] });
  expect(index.metadata(newer.id)).toEqual(refs);
  expect(index.related({ namespace: "wormlife", entity_refs: [{ type: "character", id: "42" }] }).related_records.map(r => r.id)).toEqual([newer.id]);
});

it("requires fresh evidence and successful backup before mutation", () => {
  evidence.verified_at = "2020-01-01T00:00:00Z";
  expect(() => apply()).toThrow("Refresh ESI");
  evidence.verified_at = new Date().toISOString();
  expect(() => apply(() => { throw new Error("backup failed"); })).toThrow("backup failed");
  expect(index.metadata(firstId).entity_indexed).toBe(false);
});
