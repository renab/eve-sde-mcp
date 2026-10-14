import { afterEach, describe, expect, it, vi } from "vitest";
import { openStateDatabase } from "../../src/persistence.js";
import { NexumStore } from "../../src/nexum-store.js";
import {
  planSyntheticWormholePreview,
  normalizeWormholeSystemsFixture,
  validateWormholeSystemsFixture,
  type NexumPreviewFixture,
  type WormholeSystemsFixture,
} from "../../src/wormholesystems-fixture.js";

const now = Date.parse("2026-10-13T12:00:00.000Z");
const at = (ms = now) => new Date(ms).toISOString();
const mapId = "canonical-map-a";

function sourceFixture(): WormholeSystemsFixture {
  return {
    fixtureOnly: true,
    schemaVersion: 1,
    sourceIdentity: "synthetic:wormholesystems-fixture",
    revisionOrDigest: "synthetic-revision-1",
    fetchedAt: at(),
    observedAt: at(),
    scope: { canonicalMapId: mapId, eveSolarSystemIds: [31_000_001, 31_000_002] },
    systems: [
      { eveSolarSystemId: 31_000_001, sourceSystemId: "synthetic-system-a", status: "known", observedAt: at() },
      { eveSolarSystemId: 31_000_002, sourceSystemId: "synthetic-system-b", status: "known", observedAt: at() },
    ],
    signatures: [
      { signatureKey: "source-sig-a", scannerEveSystemId: 31_000_001, signatureCode: "ABC-123", sourceSignatureId: "src-row-a", sourceConnectionId: "src-edge-1", connectedEveSystemId: 31_000_002, status: "active", size: "synthetic-large", observedAt: at(), freshUntil: at(now + 60_000) },
      { signatureKey: "source-sig-b", scannerEveSystemId: 31_000_002, signatureCode: "DEF-456", sourceSignatureId: "src-row-b", sourceConnectionId: "src-edge-1", connectedEveSystemId: 31_000_001, status: "active", size: null, observedAt: at(), freshUntil: at(now + 60_000) },
    ],
    connections: [
      { sourceConnectionId: "src-edge-1", fromEveSystemId: 31_000_001, toEveSystemId: 31_000_002, state: "active", observedAt: at(), freshUntil: at(now + 60_000), fromSignatureKey: "source-sig-a", toSignatureKey: "source-sig-b" },
    ],
    authorityMetadata: { confirmed: false, fields: null },
  };
}

function nexumFixture(): NexumPreviewFixture {
  return {
    fixtureOnly: true,
    canonicalMapId: mapId,
    fetchedAt: at(),
    systems: [
      { nexumSystemId: "nexum-system-a", eveSolarSystemId: 31_000_001, status: "active" },
      { nexumSystemId: "nexum-system-b", eveSolarSystemId: 31_000_002, status: "active" },
    ],
    connections: [
      { nexumConnectionId: "nexum-edge-1", sourceSystemId: "nexum-system-a", targetSystemId: "nexum-system-b", status: "active", sourceSignatureRowId: "nexum-row-a", targetSignatureRowId: "nexum-row-b", observedAt: at() },
    ],
    signatures: [
      { nexumSignatureRowId: "nexum-row-a", nexumSystemId: "nexum-system-a", signatureCode: "ABC-123", status: "active", size: "C5-sized-test-only", notes: "old-a", fetchedAt: at() },
      { nexumSignatureRowId: "nexum-row-b", nexumSystemId: "nexum-system-b", signatureCode: "DEF-456", status: "active", size: null, notes: null, fetchedAt: at() },
    ],
  };
}

const renderSynthetic = ({ signature, toEveSystemId }: Parameters<typeof planSyntheticWormholePreview>[2]["renderBookmark"] extends (arg: infer A) => string | null ? A : never) =>
  `SYNTHETIC ONLY ${signature.signatureCode} → ${toEveSystemId}`;
const preview = (source = sourceFixture(), nexum = nexumFixture()) => planSyntheticWormholePreview(source, nexum,
  { now, maxAgeMs: 5 * 60_000, renderBookmark: renderSynthetic });

describe("offline WormholeSystems canonical fixture boundary", () => {
  it("strictly validates versioned synthetic snapshots and preserves system EVE IDs", () => {
    const parsed = validateWormholeSystemsFixture(sourceFixture());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.systems.map(system => system.eveSolarSystemId)).toEqual([31_000_001, 31_000_002]);
      expect(parsed.value.signatures.map(signature => [signature.status, signature.size])).toEqual([["active", "synthetic-large"], ["active", null]]);
      expect(parsed.value.authorityMetadata).toEqual({ confirmed: false, fields: null });
    }
  });

  it("normalizes fixture timestamps and collection order without mutating input", () => {
    const fixture = sourceFixture();
    fixture.scope.eveSolarSystemIds.reverse();
    fixture.systems.reverse();
    fixture.fetchedAt = "2026-10-13T14:00:00+02:00";
    const normalized = normalizeWormholeSystemsFixture(fixture);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.value.fetchedAt).toBe(at());
      expect(normalized.value.scope.eveSolarSystemIds).toEqual([31_000_001, 31_000_002]);
      expect(normalized.value.systems.map(system => system.eveSolarSystemId)).toEqual([31_000_001, 31_000_002]);
    }
    expect(fixture.scope.eveSolarSystemIds).toEqual([31_000_002, 31_000_001]);
  });

  it("fails closed for missing fields, unknown shapes, duplicate identities and contradictory references", () => {
    const missing = structuredClone(sourceFixture()) as any;
    delete missing.connections[0].state;
    expect(validateWormholeSystemsFixture(missing)).toMatchObject({ ok: false });
    const unknown = { ...sourceFixture(), guessedLiveField: true };
    expect(validateWormholeSystemsFixture(unknown)).toMatchObject({ ok: false });
    const unlabeled = { ...sourceFixture(), sourceIdentity: "unverified-source" };
    expect(validateWormholeSystemsFixture(unlabeled)).toMatchObject({ ok: false });
    const invalidDate = { ...sourceFixture(), fetchedAt: "2026-02-30T12:00:00.000Z" };
    expect(validateWormholeSystemsFixture(invalidDate)).toMatchObject({ ok: false });
    const duplicate = sourceFixture();
    duplicate.signatures.push({ ...duplicate.signatures[0], signatureKey: "duplicate-key" });
    expect(validateWormholeSystemsFixture(duplicate)).toMatchObject({ ok: false });
    const contradiction = sourceFixture();
    contradiction.connections[0].toSignatureKey = "source-sig-a";
    expect(validateWormholeSystemsFixture(contradiction)).toMatchObject({ ok: false });
  });

  it("matches both directions by EVE IDs, connection references and full signature codes", () => {
    const result = preview();
    expect(result).toMatchObject({ fixtureOnly: true, writeEligible: false, canonicalMapId: mapId, sourceRevision: "synthetic-revision-1", skipped: [] });
    expect(result.matched).toHaveLength(2);
    expect(result.matched.map(row => [row.direction.fromEveSystemId, row.direction.toEveSystemId, row.nexumSignatureRowId, row.renderedNotes])).toEqual([
      [31_000_001, 31_000_002, "nexum-row-a", "SYNTHETIC ONLY ABC-123 → 31000002"],
      [31_000_002, 31_000_001, "nexum-row-b", "SYNTHETIC ONLY DEF-456 → 31000001"],
    ]);
    expect(result.matched.map(row => [row.status, row.size])).toEqual([["active", "synthetic-large"], ["active", null]]);
  });

  it("handles reverse Nexum edge orientation without reversing source directions", () => {
    const nexum = nexumFixture();
    const edge = nexum.connections[0];
    nexum.connections[0] = { ...edge, sourceSystemId: "nexum-system-b", targetSystemId: "nexum-system-a", sourceSignatureRowId: "nexum-row-b", targetSignatureRowId: "nexum-row-a" };
    expect(preview(sourceFixture(), nexum).matched.map(row => row.direction)).toEqual([
      { fromEveSystemId: 31_000_001, toEveSystemId: 31_000_002 },
      { fromEveSystemId: 31_000_002, toEveSystemId: 31_000_001 },
    ]);
  });

  it("fails closed on stale, unknown, unmatched, duplicate-system and wrong-map inputs", () => {
    const stale = sourceFixture(); stale.observedAt = at(now - 10 * 60_000);
    expect(preview(stale).matched).toEqual([]);
    const missingObservation = sourceFixture(); missingObservation.observedAt = null;
    expect(preview(missingObservation).matched).toEqual([]);
    const missingDirection = sourceFixture(); missingDirection.connections[0].toSignatureKey = null;
    expect(preview(missingDirection).matched).toEqual([]);
    const unknown = sourceFixture(); unknown.connections[0].state = "unknown";
    expect(preview(unknown).matched).toEqual([]);
    const unmatched = nexumFixture(); unmatched.signatures[0].signatureCode = "OTHER-999";
    expect(preview(sourceFixture(), unmatched).matched).toEqual([]);
    const duplicateSystem = nexumFixture(); duplicateSystem.systems.push({ ...duplicateSystem.systems[0] });
    expect(preview(sourceFixture(), duplicateSystem).matched).toEqual([]);
    const wrongMap = nexumFixture(); wrongMap.canonicalMapId = "canonical-map-b";
    expect(preview(sourceFixture(), wrongMap).skipped[0].reason).toMatch(/map identity mismatch/);
  });

  it("fails closed on typed ambiguous inputs without relying on fixture validation", () => {
    // These malformed objects intentionally go directly to the planner; its
    // safety checks must not depend on callers first invoking the validator.
    const duplicateSourceKey = sourceFixture();
    duplicateSourceKey.signatures.push({ ...duplicateSourceKey.signatures[0] });
    const duplicateKeyPlan = preview(duplicateSourceKey);
    expect(duplicateKeyPlan).toMatchObject({ fixtureOnly: true, writeEligible: false, matched: [] });
    expect(duplicateKeyPlan.skipped[0].reason).toMatch(/duplicate source signature keys/);

    const duplicateNexumId = nexumFixture();
    duplicateNexumId.systems.push({ ...duplicateNexumId.systems[0], eveSolarSystemId: 31_000_002 });
    const duplicateIdPlan = preview(sourceFixture(), duplicateNexumId);
    expect(duplicateIdPlan).toMatchObject({ fixtureOnly: true, writeEligible: false, matched: [] });
    expect(duplicateIdPlan.skipped[0].reason).toMatch(/mapping is contradictory/);

    const duplicateEveId = nexumFixture();
    duplicateEveId.systems.push({ ...duplicateEveId.systems[0], nexumSystemId: "nexum-system-alias" });
    const duplicateEvePlan = preview(sourceFixture(), duplicateEveId);
    expect(duplicateEvePlan).toMatchObject({ fixtureOnly: true, writeEligible: false, matched: [] });
    expect(duplicateEvePlan.skipped[0].reason).toMatch(/mapping is contradictory/);
  });

  it("renders deterministic idempotent previews and never makes network or PATCH calls", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const nexumGet = vi.fn(), nexumPatch = vi.fn();
    const alreadyApplied = nexumFixture();
    alreadyApplied.signatures[0].notes = "SYNTHETIC ONLY ABC-123 → 31000002";
    alreadyApplied.signatures[1].notes = "SYNTHETIC ONLY DEF-456 → 31000001";
    const first = preview(sourceFixture(), alreadyApplied), second = preview(sourceFixture(), alreadyApplied);
    expect(first).toEqual(second);
    expect(first.matched.every(row => row.action === "unchanged")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(nexumGet).not.toHaveBeenCalled();
    expect(nexumPatch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});

describe("local-only WormholeSystems fixture snapshot storage", () => {
  const db = openStateDatabase(":memory:");
  const store = new NexumStore(db, () => now);
  afterEach(() => vi.restoreAllMocks());
  it("stores atomic map-isolated fixture snapshots and permanently reports writes disabled", () => {
    const insertMap = (id: string) => db.prepare("INSERT INTO nexum_maps VALUES (?,?,?,?,?)").run(id, "https://nexum.example", id, JSON.stringify({ id }), JSON.stringify({ systems: [], connections: [] }));
    insertMap(mapId); insertMap("canonical-map-b");
    const first = sourceFixture();
    expect(store.saveWormholeSystemsFixture(mapId, first)).toMatchObject({ fixtureOnly: true, writeEligible: false });
    expect(store.wormholeSystemsFixture(mapId)).toEqual(first);
    expect(store.wormholeSystemsFixture("canonical-map-b")).toBeUndefined();
    const planned = preview(first);
    store.saveWormholeSystemsFixturePreview(mapId, planned);
    expect(store.wormholeSystemsFixturePreview(mapId)).toEqual(planned);
    const otherMapFixture = structuredClone(first);
    otherMapFixture.scope.canonicalMapId = "canonical-map-b";
    store.saveWormholeSystemsFixture("canonical-map-b", otherMapFixture);
    expect(otherMapFixture.revisionOrDigest).toBe(planned.sourceRevision);
    expect(planned.canonicalMapId).toBe(mapId);
    expect(() => store.saveWormholeSystemsFixturePreview("canonical-map-b", planned)).toThrow(/canonical map identity mismatch/);
    db.prepare("INSERT INTO wormholesystems_fixture_previews(map_id,source_revision,preview_json,created_at) VALUES (?,?,?,?)")
      .run("canonical-map-b", planned.sourceRevision, JSON.stringify(planned), now);
    expect(store.wormholeSystemsFixturePreview("canonical-map-b")).toBeUndefined();
    expect(store.wormholeSystemsFixtureStatus("canonical-map-b").last_fixture_preview).toBeNull();
    expect(store.wormholeSystemsFixtureStatus(mapId)).toMatchObject({ integration_mode: "disabled_fixture_only", present: true, eligible_for_fixture_preview: true, eligible_for_writes: false,
      last_fixture_preview: { source_revision: "synthetic-revision-1", matched_count: 2, skipped_count: 0, write_eligible: false } });
    const invalid = structuredClone(first) as any; invalid.schemaVersion = 2;
    expect(() => store.saveWormholeSystemsFixture(mapId, invalid)).toThrow(/Invalid WormholeSystems fixture/);
    expect(store.wormholeSystemsFixture(mapId)?.revisionOrDigest).toBe("synthetic-revision-1");
    const replacement = structuredClone(first); replacement.revisionOrDigest = "synthetic-revision-2";
    store.saveWormholeSystemsFixture(mapId, replacement);
    expect(store.wormholeSystemsFixturePreview(mapId)).toBeUndefined();
    expect(store.wormholeSystemsFixtureStatus(mapId).last_fixture_preview).toBeNull();
    expect((db.prepare("SELECT * FROM wormholesystems_fixture_runs WHERE map_id=?").all(mapId) as unknown[])).toHaveLength(2);
    expect((db.prepare("SELECT * FROM nexum_resources").all() as unknown[])).toHaveLength(0);
    db.close();
  });
});
