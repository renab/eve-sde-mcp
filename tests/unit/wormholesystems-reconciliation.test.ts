import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  allianceNoteWriteEligibility, renderAllianceNote, summarizeTopologyWriteResponse, topologyCandidateFromFixture,
  validateWormholesystemsTopologyRequest,
} from "../../src/wormholesystems-reconciliation.js";
import { normalizeSourceSnapshot } from "../../src/wormholesystems-adapter.js";
import { canonicalSolarSystemClassFromSde } from "../../src/wormholesystems.js";

const now = Date.parse("2026-10-13T12:00:00.000Z");
const at = new Date(now - 1_000).toISOString();

function completeSourceSnapshot() {
  const mapId = "source-map";
  const rows = [
    { id: "member-home", map_id: mapId, solarsystem_id: 31_000_001, alias: "0", status: "SAFE", position: { x: 10, y: 20 } },
    { id: "member-branch", map_id: mapId, solarsystem_id: 31_000_002, alias: "12", status: "SAFE", position: { x: 30, y: 40 } },
  ];
  const sigA = { id: "signature-resource-a", signature_id: "ABC-123", map_solarsystem_id: "member-home", map_connection_id: "edge-a" };
  const sigB = { id: "signature-resource-b", signature_id: "DEF-456", map_solarsystem_id: "member-branch", map_connection_id: "edge-a" };
  const edge = { id: "edge-a", from_map_solarsystem_id: "member-home", to_map_solarsystem_id: "member-branch",
    type: "standard", ship_size: "medium", mass_status: "critical", lifetime_status: "expired",
    signatures: [
      { id: sigA.id, signature_id: sigA.signature_id, map_solarsystem_id: sigA.map_solarsystem_id },
      { id: sigB.id, signature_id: sigB.signature_id, map_solarsystem_id: sigB.map_solarsystem_id },
    ] };
  const detailFor = (id: string, eveId: number, signature: typeof sigA) => ({ data: {
    id, map_id: mapId, solarsystem_id: eveId, alias: rows.find(row => row.id === id)!.alias,
    signatures: [{ ...signature, status: "inactive" }], map_connections: [edge], audits: [],
  } });
  return normalizeSourceSnapshot({ mapId, canonicalMapId: "target-map",
    sourceIdentity: `wormholesystems:${JSON.stringify(["https://source.example", mapId])}`,
    revisionOrDigest: "digest-1", fetchedAt: at,
    detail: { data: { id: mapId, home_solarsystem_id: 31_000_001, map_solarsystems: rows, map_connections: [edge],
      bookmark_settings: { status_annotations: ["SAFE", "HOSTILE"] } } },
    systemDetails: [detailFor("member-home", 31_000_001, sigA), detailFor("member-branch", 31_000_002, sigB)],
  });
}

describe("WormholeSystems source-owned Nexum reconciliation", () => {
  it("renders destination classes from canonical SDE data, never target-map classes", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE mapSolarSystems (solarSystemID INTEGER PRIMARY KEY, security REAL); CREATE TABLE mapLocationWormholeClasses (locationID INTEGER PRIMARY KEY, wormholeClassID INTEGER)");
    db.prepare("INSERT INTO mapSolarSystems VALUES (?,?)").run(31_000_001, -1);
    db.prepare("INSERT INTO mapSolarSystems VALUES (?,?)").run(30_000_001, 0.8);
    db.prepare("INSERT INTO mapSolarSystems VALUES (?,?)").run(30_000_002, 0.3);
    db.prepare("INSERT INTO mapSolarSystems VALUES (?,?)").run(30_000_003, 0);
    db.prepare("INSERT INTO mapSolarSystems VALUES (?,?)").run(30_000_004, -1);
    db.prepare("INSERT INTO mapLocationWormholeClasses VALUES (?,?)").run(31_000_001, 3);
    expect(canonicalSolarSystemClassFromSde(db, 31_000_001)).toBe("C3");
    expect(canonicalSolarSystemClassFromSde(db, 30_000_001)).toBe("HS");
    expect(canonicalSolarSystemClassFromSde(db, 30_000_002)).toBe("LS");
    expect(canonicalSolarSystemClassFromSde(db, 30_000_003)).toBe("NS");
    expect(canonicalSolarSystemClassFromSde(db, 30_000_004)).toBeNull();
    expect(canonicalSolarSystemClassFromSde(db, 99_000_001)).toBeNull();
    db.close();
  });

  it("normalizes real source rows into a supported topology request and alliance-note evidence", () => {
    const result = completeSourceSnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fixture = result.fixture;
    const request = validateWormholesystemsTopologyRequest(topologyCandidateFromFixture(fixture), now);
    expect(request).toEqual({ request: {
      sourceIdentity: `wormholesystems:${JSON.stringify(["https://source.example", "source-map"])}`,
      snapshot: { complete: true, fetchedAt: at },
      systems: [
        { sourceSystemId: "member-home", eveSystemId: 31_000_001, positionX: 10, positionY: 20 },
        { sourceSystemId: "member-branch", eveSystemId: 31_000_002, positionX: 30, positionY: 40 },
      ],
      connections: [{ sourceConnectionId: "edge-a", fromSourceSystemId: "member-home", toSourceSystemId: "member-branch",
        connection_type: "standard", ship_size: "medium" }],
    }, blockers: [] });
    expect(Object.keys(request.request!.snapshot).sort()).toEqual(["complete", "fetchedAt"]);
    expect(Object.keys(request.request!.connections[0]).sort()).toEqual(["connection_type", "fromSourceSystemId", "ship_size", "sourceConnectionId", "toSourceSystemId"]);
    expect(fixture.connections).toMatchObject([{ sourceConnectionId: "edge-a", state: "unknown" }]);
    expect(fixture.topologyEvidence?.connections).toEqual([{ sourceConnectionId: "edge-a", fromSourceSystemId: "member-home",
      toSourceSystemId: "member-branch", connectionType: "standard", size: "medium" }]);
    expect(fixture.allianceNoteEvidence).toMatchObject({ knownStatusAnnotations: ["HOSTILE", "SAFE"],
      connections: [{ sourceConnectionId: "edge-a", size: "medium" }] });
    expect(fixture.allianceNoteEvidence?.systems).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceSystemId: "member-home", alias: "0", isHome: true, statusAnnotation: "SAFE" }),
      expect.objectContaining({ sourceSystemId: "member-branch", alias: "12", isHome: false, statusAnnotation: "SAFE" }),
    ]));
    // Expired mass/lifetime annotations and inactive visual signature status do
    // not remove a connection that is present in the complete map list.
    expect(request.request?.connections).toHaveLength(1);
  });

  it("blocks missing coordinates and unsupported source type/ship size without inventing defaults", () => {
    const normalized = completeSourceSnapshot();
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const candidate = topologyCandidateFromFixture(normalized.fixture);
    const systems = (candidate.systems as any[]).map((row, index) => index ? row : { ...row, positionX: null });
    const missingPosition = validateWormholesystemsTopologyRequest({ ...candidate, systems }, now);
    expect(missingPosition.request).toBeUndefined();
    expect(missingPosition.blockers).toContain("systems[0].positionX: verified source-owned map position is unavailable");

    const connections = (candidate.connections as any[]).map(row => ({ ...row, connection_type: "wormhole", ship_size: "xlarge" }));
    const unsupported = validateWormholesystemsTopologyRequest({ ...candidate, connections }, now);
    expect(unsupported.request).toBeUndefined();
    expect(unsupported.blockers).toEqual(expect.arrayContaining([
      "connections[0].connection_type: validated source connection type is unavailable",
      "connections[0].ship_size: validated source connection size is unavailable",
    ]));
    const camelCase = validateWormholesystemsTopologyRequest({ ...candidate,
      connections: [{ ...(candidate.connections as any[])[0], connectionType: "standard", size: "medium" }] }, now);
    expect(camelCase.request).toBeUndefined();
    expect(camelCase.blockers).toContain("connections[0]: contains an unsupported field");
  });

  it("uses the approved runtime default bound and rejects client-selected freshness or generation fields", () => {
    const normalized = completeSourceSnapshot();
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const fixture = normalized.fixture;
    const candidate = topologyCandidateFromFixture(fixture);
    expect(validateWormholesystemsTopologyRequest(candidate, now).request).toBeDefined();
    const stale = { ...candidate, snapshot: { ...(candidate.snapshot as object), fetchedAt: new Date(now - 60_001).toISOString() } };
    expect(validateWormholesystemsTopologyRequest(stale, now).blockers)
      .toContain("snapshot.fetchedAt: missing, future-dated, or stale");
    expect(validateWormholesystemsTopologyRequest({ ...candidate,
      snapshot: { ...(candidate.snapshot as object), maxAgeMs: 30_000 } }, now).blockers)
      .toContain("snapshot: contains an unsupported field");
    expect(validateWormholesystemsTopologyRequest({ ...candidate,
      snapshot: { ...(candidate.snapshot as object), generation: "rev-1" } }, now).blockers)
      .toContain("snapshot: contains an unsupported field");
    expect(candidate.snapshot).not.toHaveProperty("observedAt");
    expect(fixture.topologyEvidence).not.toHaveProperty("maxAgeMs");
  });

  it("reports row-level conflicts and no-op outcomes separately from successful request submission", () => {
    expect(summarizeTopologyWriteResponse({ createdSystems: 1, preservedSystems: 2, updatedSystems: 0, deletedSystems: 0,
      createdConnections: 0, preservedConnections: 1, updatedConnections: 0, deletedConnections: 0,
      conflicts: [{ itemId: "safe-id", reason: "preserved" }, { itemId: "other-id", reason: "conflict" }] }))
      .toEqual({ request_status: "succeeded", status: "completed", reconciliation_status: "partial",
        created_systems: 1, updated_systems: 0, deleted_systems: 0, preserved_systems: 2,
        created_connections: 0, updated_connections: 0, deleted_connections: 0, preserved_connections: 1, conflict_count: 2 });
    expect(summarizeTopologyWriteResponse({ createdSystems: 0, preservedSystems: 0, updatedSystems: 0, deletedSystems: 0,
      createdConnections: 0, preservedConnections: 0, updatedConnections: 0, deletedConnections: 0, conflicts: [] }))
      .toMatchObject({ request_status: "succeeded", status: "completed", reconciliation_status: "unchanged", conflict_count: 0 });
  });
});

describe("alliance signature-note rendering", () => {
  const base = {
    fromSourceSystemId: "member-home", toSourceSystemId: "member-branch",
    fromAlias: "0", fromIsHome: true, toAlias: "12", toIsHome: false,
    signatureCode: "ABC-123", destinationClass: "C3", size: "medium",
    knownStatusAnnotations: new Set(["SAFE", "HOSTILE"]),
  };

  it("renders exact forward and reverse directions with home zero and decimal aliases", () => {
    expect(renderAllianceNote(base)).toEqual({ note: ".0-12 ABC-123 C3 medium", blockers: [] });
    expect(renderAllianceNote({ ...base, fromAlias: "12", fromIsHome: false, toAlias: "0", toIsHome: true,
      signatureCode: "DEF-456", destinationClass: "HS", size: "large", reverse: true }))
      .toEqual({ note: "..12-0 DEF-456 HS large", blockers: [] });
  });

  it("appends only explicit vocabulary annotations and blocks invalid or ambiguous per-direction data", () => {
    expect(renderAllianceNote({ ...base, statusAnnotation: "SAFE" }).note).toBe(".0-12 ABC-123 C3 medium SAFE");
    const unknownStatus = renderAllianceNote({ ...base, statusAnnotation: "NOT-VALIDATED" });
    expect(unknownStatus.note).toBeUndefined();
    expect(unknownStatus.blockers).toContain("statusAnnotation: annotation is not in the validated alliance status vocabulary");
    expect(renderAllianceNote({ ...base, fromAlias: "home", fromIsHome: false }).blockers)
      .toContain("fromAlias: validated positive decimal branch alias is required");
    expect(renderAllianceNote({ ...base, fromAlias: "1", fromIsHome: true }).blockers)
      .toContain("fromAlias: validated home alias 0 is required");
    expect(renderAllianceNote({ ...base, fromIsHome: undefined }).blockers).toContain("fromIsHome: validated home identity is required");
    expect(renderAllianceNote({ ...base, toAlias: "01" }).blockers).toContain("toAlias: validated positive decimal branch alias is required");
    expect(renderAllianceNote({ ...base, signatureCode: undefined }).blockers).toContain("signatureCode: validated source signature code is required");
    expect(renderAllianceNote({ ...base, destinationClass: null }).blockers).toContain("destinationClass: validated destination class is required");
  });

  it("requires fresh exact target identity and preserves non-empty notes without relying on source liveness", () => {
    const rendered = renderAllianceNote(base);
    const eligible = (overrides: Partial<Parameters<typeof allianceNoteWriteEligibility>[0]> = {}) => allianceNoteWriteEligibility({
      rendered, snapshotFresh: true, identityMatched: true, targetRowAvailable: true, currentNote: "", decisionBoundaryHeld: true, ...overrides,
    });
    expect(eligible()).toEqual({ eligible: true, blockers: [] });
    expect(eligible({ snapshotFresh: false }).eligible).toBe(false);
    expect(eligible({ identityMatched: false }).eligible).toBe(false);
    expect(eligible({ currentNote: "manual note" }).blockers).toContain("current note: non-empty manual note is preserved");
  });
});
