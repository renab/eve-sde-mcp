import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  allianceNoteWriteEligibility, renderAllianceNote, summarizeTopologyWriteResponse, topologyCandidateFromFixture,
  topologyProjectionFromFixture,
  validateWormholesystemsTopologyRequest,
} from "../../src/wormholesystems-reconciliation.js";
import { normalizeSourceSnapshot } from "../../src/wormholesystems-adapter.js";
import { canonicalSolarSystemClassFromSde } from "../../src/wormholesystems.js";

const now = Date.parse("2026-10-13T12:00:00.000Z");
const at = new Date(now - 1_000).toISOString();

function completeSourceSnapshot(detailPosition?: { memberId: string; position: unknown }) {
  const mapId = "source-map";
  const rows = [
    { id: "member-home", map_id: mapId, solarsystem_id: 31_000_001, alias: "0", status: "SAFE", position: { x: 10, y: 20 } },
    { id: "member-branch", map_id: mapId, solarsystem_id: 31_000_002, alias: "12", status: "SAFE", position: { x: 30, y: 40 } },
  ];
  const sigA = { id: "signature-resource-a", signature_id: "ABC-123", map_solarsystem_id: "member-home", map_connection_id: "edge-a" };
  const sigB = { id: "signature-resource-b", signature_id: "DEF-456", map_solarsystem_id: "member-branch", map_connection_id: "edge-a" };
  const edge = { id: "edge-a", from_map_solarsystem_id: "member-home", to_map_solarsystem_id: "member-branch",
    type: "wormhole", ship_size: "medium", mass_status: "critical", lifetime_status: "expired",
    signatures: [
      { id: sigA.id, signature_id: sigA.signature_id, map_solarsystem_id: sigA.map_solarsystem_id },
      { id: sigB.id, signature_id: sigB.signature_id, map_solarsystem_id: sigB.map_solarsystem_id },
    ] };
  const detailFor = (id: string, eveId: number, signature: typeof sigA) => ({ data: {
    id, map_id: mapId, solarsystem_id: eveId, alias: rows.find(row => row.id === id)!.alias,
    ...(detailPosition?.memberId === id ? { position: detailPosition.position } : {}),
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
  it("rejects a selected-system position that contradicts the map member canvas position", () => {
    const result = completeSourceSnapshot({ memberId: "member-home", position: { x: 999, y: 20 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContainEqual({ path: "$.systemDetails[0].data.position",
      reason: "selected-system position contradicts the selected map member position" });
  });

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
    const projection = topologyProjectionFromFixture(fixture);
    expect(projection.blockers).toEqual([]);
    expect(projection.candidate.connections).toEqual([{ sourceConnectionId: "edge-a", fromSourceSystemId: "member-home",
      toSourceSystemId: "member-branch", sourceSignatureId: "signature-resource-a", targetSignatureId: "signature-resource-b",
      connection_type: "standard", ship_size: "medium" }]);
    expect(projection.candidate.signatures).toEqual([
      { sourceSignatureId: "signature-resource-a", sourceSystemId: "member-home", sourceConnectionId: "edge-a", sigId: "ABC-123", sigType: "unknown", whType: "" },
      { sourceSignatureId: "signature-resource-b", sourceSystemId: "member-branch", sourceConnectionId: "edge-a", sigId: "DEF-456", sigType: "unknown", whType: "" },
    ]);
    const request = validateWormholesystemsTopologyRequest(projection.candidate, now);
    expect(request).toEqual({ request: {
      schemaVersion: 2,
      sourceIdentity: `wormholesystems:${JSON.stringify(["https://source.example", "source-map"])}`,
      snapshot: { complete: true, fetchedAt: at },
      systems: [
        { sourceSystemId: "member-branch", eveSystemId: 31_000_002, positionX: 30, positionY: 40 },
        { sourceSystemId: "member-home", eveSystemId: 31_000_001, positionX: 10, positionY: 20 },
      ],
      connections: [{ sourceConnectionId: "edge-a", fromSourceSystemId: "member-home", toSourceSystemId: "member-branch",
        sourceSignatureId: "signature-resource-a", targetSignatureId: "signature-resource-b",
        connection_type: "standard", ship_size: "medium" }],
      signatures: [
        { sourceSignatureId: "signature-resource-a", sourceSystemId: "member-home", sourceConnectionId: "edge-a", sigId: "ABC-123", sigType: "unknown", whType: "" },
        { sourceSignatureId: "signature-resource-b", sourceSystemId: "member-branch", sourceConnectionId: "edge-a", sigId: "DEF-456", sigType: "unknown", whType: "" },
      ],
    }, blockers: [] });
    expect(Object.keys(request.request!.snapshot).sort()).toEqual(["complete", "fetchedAt"]);
    expect(Object.keys(request.request!.connections[0]).sort()).toEqual(["connection_type", "fromSourceSystemId", "ship_size", "sourceConnectionId", "sourceSignatureId", "targetSignatureId", "toSourceSystemId"]);
    expect(Object.keys(request.request!.signatures[0]).sort()).toEqual(["sigId", "sigType", "sourceConnectionId", "sourceSignatureId", "sourceSystemId", "whType"]);
    expect(fixture.connections).toMatchObject([{ sourceConnectionId: "edge-a", state: "unknown" }]);
    expect(fixture.topologyEvidence?.connections).toEqual([{ sourceConnectionId: "edge-a", fromSourceSystemId: "member-home",
      toSourceSystemId: "member-branch", connectionType: "wormhole", size: "medium" }]);
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

  it.each([
    ["Wormhole", "wormhole", "B274"],
    ["Data Site", "data", ""],
    ["Relic Site", "relic", ""],
    ["Combat Site", "combat", ""],
    ["Gas Site", "gas", ""],
    ["Ore Site", "ore", ""],
  ])("maps exact source category %s without numeric or type-name inference", (name, expectedType, expectedWhType) => {
    const result = completeSourceSnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.fixture.sourceSignatureEvidence![0];
    Object.assign(evidence, { signatureCategoryName: name, signatureCategoryId: 17, nestedSignatureCategoryId: 17,
      signatureTypeCategoryId: 17, signatureTypeId: 197, nestedSignatureTypeId: 197 });
    if (name === "Wormhole") Object.assign(evidence, { wormholeId: 26, nestedWormholeId: 26, wormholeName: "B274" });
    const projection = topologyProjectionFromFixture(result.fixture);
    expect(projection.blockers).toEqual([]);
    expect((projection.candidate.signatures as any[]).find(row => row.sourceSignatureId === "signature-resource-a"))
      .toMatchObject({ sigType: expectedType, whType: expectedWhType });
  });

  it("retains unsupported, absent and null categories as unknown and blocks contradictory wormhole relations", () => {
    const project = (name: string | null | undefined, wormhole: boolean | "name-only" = false) => {
      const result = completeSourceSnapshot();
      if (!result.ok) throw new Error("source fixture failed to normalize");
      const evidence = result.fixture.sourceSignatureEvidence![0];
      Object.assign(evidence, { signatureCategoryId: 1, nestedSignatureCategoryId: 1,
        signatureTypeCategoryId: 1, signatureTypeId: 197, nestedSignatureTypeId: 197 });
      if (name !== undefined) evidence.signatureCategoryName = name;
      if (wormhole === true) Object.assign(evidence, { wormholeId: 26, nestedWormholeId: 26, wormholeName: "B274" });
      if (wormhole === "name-only") Object.assign(evidence, { wormholeName: "B274" });
      return topologyProjectionFromFixture(result.fixture);
    };
    for (const name of ["Homefront Operations", "Factional Warfare Site", "Future Site", ""] as const) {
      const projection = project(name, true);
      expect(projection.blockers).toEqual([]);
      expect((projection.candidate.signatures as any[])[0]).toMatchObject({ sigType: "unknown", whType: "" });
      expect(projection.diagnostics.join(" ")).toContain("type_unmapped");
    }
    for (const name of [null, undefined] as const) {
      const projection = project(name, true);
      expect(projection.blockers).toEqual([]);
      expect((projection.candidate.signatures as any[])[0]).toMatchObject({ sigType: "unknown", whType: "" });
    }
    const contradictory = project("Data Site", true);
    expect(contradictory.blockers).toContain(
      "signatures[signature-resource-a].wormhole_id: wormhole relation contradicts the validated non-wormhole category");
    const contradictoryNameOnly = project("Relic Site", "name-only");
    expect(contradictoryNameOnly.blockers).toContain(
      "signatures[signature-resource-a].wormhole_id: wormhole relation contradicts the validated non-wormhole category");
    const noCategoryDespiteTypeEvidence = project(undefined, true);
    expect((noCategoryDespiteTypeEvidence.candidate.signatures as any[])[0]).toMatchObject({ sigType: "unknown", whType: "" });
  });

  it("requires complete wormhole identity evidence for a non-empty related name", () => {
    const project = (relation: { wormholeId?: unknown; nestedWormholeId?: unknown; wormholeName?: unknown }) => {
      const result = completeSourceSnapshot();
      if (!result.ok) throw new Error("source fixture failed to normalize");
      Object.assign(result.fixture.sourceSignatureEvidence![0], { signatureCategoryName: "Wormhole", ...relation });
      return topologyProjectionFromFixture(result.fixture);
    };
    const noRelationOrName = project({});
    expect(noRelationOrName.blockers).toEqual([]);
    expect((noRelationOrName.candidate.signatures as any[])[0]).toMatchObject({ sigType: "wormhole", whType: "" });

    for (const relation of [
      { wormholeName: "B274" },
      { wormholeId: 26, wormholeName: "B274" },
      { nestedWormholeId: 26, wormholeName: "B274" },
      { wormholeId: 26, nestedWormholeId: 27, wormholeName: "B274" },
      { wormholeId: 26 },
      { nestedWormholeId: 26 },
      { wormholeId: 26, nestedWormholeId: 27 },
    ]) {
      const projection = project(relation);
      expect(projection.blockers).toContain(
        "signatures[signature-resource-a].wormhole_id: Wormhole classification has a partial or contradictory relation/name");
    }

    for (const relation of [
      { wormholeId: 26, nestedWormholeId: 26 },
      { wormholeId: 26, nestedWormholeId: 26, wormholeName: "" },
      { wormholeId: 26, nestedWormholeId: 26, wormholeName: "B274" },
    ]) {
      const projection = project(relation);
      expect(projection.blockers).toEqual([]);
      expect((projection.candidate.signatures as any[])[0]).toMatchObject({
        sigType: "wormhole", whType: relation.wormholeName || "",
      });
    }
  });

  it("projects prototype-named unsupported categories as valid unknown signatures", () => {
    for (const category of ["constructor", "toString", "__proto__"]) {
      const result = completeSourceSnapshot();
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      for (const evidence of result.fixture.sourceSignatureEvidence!) evidence.signatureCategoryName = category;
      const projection = topologyProjectionFromFixture(result.fixture);
      expect(projection.blockers).toEqual([]);
      const signatures = projection.candidate.signatures as Array<{ sigType: string; whType: string }>;
      expect(signatures).toHaveLength(2);
      expect(signatures.every(signature => signature.sigType === "unknown" && signature.whType === "")).toBe(true);
      expect(projection.diagnostics).toHaveLength(2);
      expect(projection.diagnostics.every(message => message.includes("type_unmapped"))).toBe(true);
      const validated = validateWormholesystemsTopologyRequest(projection.candidate, now);
      expect(validated.blockers).toEqual([]);
      expect(validated.request?.signatures).toHaveLength(2);
    }
  });

  it("projects all source-present signatures in a mixed 100-row v3 snapshot", () => {
    const names = ["Wormhole", "Data Site", "Relic Site", "Combat Site", "Gas Site", "Ore Site", "Homefront Operations", "Factional Warfare Site"];
    const types: Record<string, string> = { Wormhole: "wormhole", "Data Site": "data", "Relic Site": "relic",
      "Combat Site": "combat", "Gas Site": "gas", "Ore Site": "ore" };
    const signatures = Array.from({ length: 100 }, (_, index) => {
      const name = names[index % names.length];
      const categoryId = index % names.length + 1;
      const typeId = 1_000 + index;
      return { id: `signature-resource-${String(index).padStart(3, "0")}`, signature_id: `SIG-${String(index).padStart(3, "0")}`,
        map_solarsystem_id: "member", signature_category_id: categoryId, signature_category: { id: categoryId, name },
        signature_type_id: typeId, signature_type: { id: typeId, signature_category_id: categoryId, name: "Combat Site" } };
    });
    const normalized = normalizeSourceSnapshot({ mapId: "source-map", canonicalMapId: "target-map",
      sourceIdentity: `wormholesystems:${JSON.stringify(["https://source.example", "source-map"])}`,
      revisionOrDigest: "100-row-digest", fetchedAt: at,
      detail: { data: { id: "source-map", map_solarsystems: [{ id: "member", map_id: "source-map", solarsystem_id: 31_000_001 }], map_connections: [] } },
      systemDetails: [{ data: { id: "member", map_id: "source-map", solarsystem_id: 31_000_001,
        signatures, map_connections: [], audits: [] } }],
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const projection = topologyProjectionFromFixture(normalized.fixture);
    expect(projection.blockers).toEqual([]);
    const rows = projection.candidate.signatures as Array<{ sourceSignatureId: string; sigType: string; whType: string }>;
    expect(rows).toHaveLength(100);
    for (const [index, name] of names.entries()) {
      const row = rows.find(item => item.sourceSignatureId === `signature-resource-${String(index).padStart(3, "0")}`);
      expect(row).toMatchObject({ sigType: types[name] ?? "unknown", whType: "" });
    }
    expect(rows.filter(row => row.sigType === "unknown")).toHaveLength(24);
  });

  it("requires a newly validated v3 source fixture for projection and never upgrades v2 evidence", () => {
    const result = completeSourceSnapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const legacy = structuredClone(result.fixture);
    legacy.schemaVersion = 2;
    const projection = topologyProjectionFromFixture(legacy);
    expect(projection.blockers).toContain("signatures: a newly fetched version-3 classification snapshot is required for data writes");
  });

  it("requires signature-side connection references to match a present edge and its scanner endpoint", () => {
    const normalized = completeSourceSnapshot();
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const candidate = topologyProjectionFromFixture(normalized.fixture).candidate as any;
    expect(validateWormholesystemsTopologyRequest(candidate, now).request).toBeDefined();

    const missingEdgeAssociation = structuredClone(candidate);
    missingEdgeAssociation.connections[0].sourceSignatureId = null;
    const missing = validateWormholesystemsTopologyRequest(missingEdgeAssociation, now);
    expect(missing.request).toBeUndefined();
    expect(missing.blockers).toContain("signatures[0].sourceConnectionId: source-side edge signature reference contradicts the explicit source association");

    const absentEdge = structuredClone(candidate);
    absentEdge.signatures[0].sourceConnectionId = "absent-edge";
    const absent = validateWormholesystemsTopologyRequest(absentEdge, now);
    expect(absent.request).toBeUndefined();
    expect(absent.blockers).toContain("signatures[0].sourceConnectionId: source connection is absent from the complete snapshot projection");

    const wrongScanner = structuredClone(candidate);
    wrongScanner.systems.push({ sourceSystemId: "member-other", eveSystemId: 31_000_003 });
    wrongScanner.signatures[0].sourceSystemId = "member-other";
    const scanner = validateWormholesystemsTopologyRequest(wrongScanner, now);
    expect(scanner.request).toBeUndefined();
    expect(scanner.blockers).toContain("signatures[0].sourceConnectionId: scanner member is not an endpoint of the source connection");

    const mismatchedEdgeAssociation = structuredClone(candidate);
    mismatchedEdgeAssociation.connections[0].sourceSignatureId = "signature-resource-b";
    const mismatched = validateWormholesystemsTopologyRequest(mismatchedEdgeAssociation, now);
    expect(mismatched.request).toBeUndefined();
    expect(mismatched.blockers).toEqual(expect.arrayContaining([
      "connections[0].sourceSignatureId: source signature scanner member contradicts the connection endpoint",
      "signatures[0].sourceConnectionId: source-side edge signature reference contradicts the explicit source association",
    ]));

    const oldFields = structuredClone(candidate);
    oldFields.connections[0].fromSourceSignatureId = oldFields.connections[0].sourceSignatureId;
    oldFields.connections[0].toSourceSignatureId = oldFields.connections[0].targetSignatureId;
    delete oldFields.connections[0].sourceSignatureId;
    delete oldFields.connections[0].targetSignatureId;
    const unsupported = validateWormholesystemsTopologyRequest(oldFields, now);
    expect(unsupported.request).toBeUndefined();
    expect(unsupported.blockers).toEqual(expect.arrayContaining([
      "connections[0]: contains an unsupported field",
      "connections[0].sourceSignatureId: expected a validated source signature ID or null",
      "connections[0].targetSignatureId: expected a validated source signature ID or null",
    ]));
  });

  it("projects unassociated signatures with a null source connection and accepts them independently", () => {
    const normalized = completeSourceSnapshot();
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    normalized.fixture.signatures.push({ signatureKey: "source-signature:31000001:signature-standalone",
      scannerEveSystemId: 31_000_001, signatureCode: null, sourceSignatureId: "signature-standalone",
      sourceConnectionId: null, connectedEveSystemId: null, status: "unknown", size: null, observedAt: null, freshUntil: null });
    normalized.fixture.sourceSignatureEvidence!.push({ sourceSignatureId: "signature-standalone", scannerEveSystemId: 31_000_001,
      signatureCode: null });

    const projection = topologyProjectionFromFixture(normalized.fixture);
    expect(projection.blockers).toEqual([]);
    expect(projection.candidate.signatures).toContainEqual({ sourceSignatureId: "signature-standalone", sourceSystemId: "member-home",
      sourceConnectionId: null, sigId: "", sigType: "unknown", whType: "" });
    const checked = validateWormholesystemsTopologyRequest(projection.candidate, now);
    expect(checked.request?.signatures).toContainEqual({ sourceSignatureId: "signature-standalone", sourceSystemId: "member-home",
      sourceConnectionId: null, sigId: "", sigType: "unknown", whType: "" });
  });

  it("omits unavailable coordinate pairs and rejects partial or malformed pairs", () => {
    const normalized = completeSourceSnapshot();
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const evidence = normalized.fixture.topologyEvidence!;
    evidence.systems = evidence.systems.map(system => system.sourceSystemId === "member-home"
      ? { ...system, positionX: null, positionY: null } : system);
    const candidate = topologyCandidateFromFixture(normalized.fixture);
    const homeCandidate = (candidate.systems as any[]).find(row => row.sourceSystemId === "member-home");
    expect(homeCandidate).not.toHaveProperty("positionX");
    expect(homeCandidate).not.toHaveProperty("positionY");
    const unavailablePair = validateWormholesystemsTopologyRequest(candidate, now);
    expect(unavailablePair.blockers).toEqual([]);
    const homeRequest = unavailablePair.request?.systems.find(row => row.sourceSystemId === "member-home");
    expect(homeRequest).toBeDefined();
    // No coordinates are serialized: Nexum can use its creation default without overwriting existing/manual positions.
    expect(homeRequest).not.toHaveProperty("positionX");
    expect(homeRequest).not.toHaveProperty("positionY");

    const partialSystems = (candidate.systems as any[]).map(row => row.sourceSystemId === "member-branch"
      ? { ...row, positionY: null } : row);
    const partialPosition = validateWormholesystemsTopologyRequest({ ...candidate, systems: partialSystems }, now);
    expect(partialPosition.request).toBeUndefined();
    expect(partialPosition.blockers).toContain("systems[0].positionY: verified source-owned map position is unavailable");

    const malformedSystems = (candidate.systems as any[]).map(row => row.sourceSystemId === "member-branch"
      ? { ...row, positionX: "30" } : row);
    const malformedPosition = validateWormholesystemsTopologyRequest({ ...candidate, systems: malformedSystems }, now);
    expect(malformedPosition.request).toBeUndefined();
    expect(malformedPosition.blockers).toContain("systems[0].positionX: verified source-owned map position is unavailable");

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

  it("requires a recognized accepted or replayed checkpoint before treating counters as a reconciliation result", () => {
    const counts = { createdSystems: 0, preservedSystems: 0, updatedSystems: 0, deletedSystems: 0,
      createdConnections: 0, preservedConnections: 0, updatedConnections: 0, deletedConnections: 0,
      createdSignatures: 0, preservedSignatures: 0, updatedSignatures: 0, deletedSignatures: 0, conflicts: [] };
    expect(summarizeTopologyWriteResponse(counts)).toMatchObject({ reconciliation_status: "unknown", checkpoint: null });
    expect(summarizeTopologyWriteResponse({ ...counts, checkpoint: { accepted: "yes", replayed: false, partial: false } }))
      .toMatchObject({ reconciliation_status: "unknown", checkpoint: null });
    expect(summarizeTopologyWriteResponse({ ...counts, checkpoint: { accepted: true } }))
      .toMatchObject({ reconciliation_status: "unknown", checkpoint: null });
    expect(summarizeTopologyWriteResponse({ ...counts, checkpoint: { accepted: true, replayed: false, partial: false } }))
      .toMatchObject({ reconciliation_status: "unchanged", checkpoint: { accepted: true, replayed: false, partial: false } });
    expect(summarizeTopologyWriteResponse({ ...counts, checkpoint: { accepted: false, replayed: true, partial: false } }))
      .toMatchObject({ reconciliation_status: "unchanged", checkpoint: { accepted: false, replayed: true, partial: false } });
    expect(summarizeTopologyWriteResponse({ ...counts, checkpoint: { accepted: false, replayed: false, partial: false } }))
      .toMatchObject({ reconciliation_status: "unknown", checkpoint: { accepted: false, replayed: false, partial: false } });
  });

  it("reports row-level conflicts and no-op outcomes separately from successful request submission", () => {
    const summary = summarizeTopologyWriteResponse({ createdSystems: 1, preservedSystems: 2, updatedSystems: 0, deletedSystems: 0,
      createdConnections: 0, preservedConnections: 1, updatedConnections: 0, deletedConnections: 0,
      createdSignatures: 0, preservedSignatures: 0, updatedSignatures: 0, deletedSignatures: 0,
      mappings: { systems: [{ sourceSystemId: "source-member", nexumSystemId: "nexum-row", ownership: "owned", status: "created",
        notes: "private note must not be exposed" }] }, snapshotFetchedAt: at, payloadDigest: "a".repeat(64),
      checkpoint: { accepted: true, replayed: false, partial: true },
      conflicts: [{ itemId: "safe-id", reason: "preserved" }, { itemId: "other-id", reason: "conflict" }] });
    expect(summary).toMatchObject({ request_status: "succeeded", status: "completed", reconciliation_status: "partial",
        created_systems: 1, updated_systems: 0, deleted_systems: 0, preserved_systems: 2,
        created_connections: 0, updated_connections: 0, deleted_connections: 0, preserved_connections: 1,
        created_signatures: 0, updated_signatures: 0, deleted_signatures: 0, preserved_signatures: 0, conflict_count: 2,
        conflicts: expect.arrayContaining([expect.objectContaining({ source_id: "safe-id", reason: "Nexum reported a row-level reconciliation conflict" })]),
        mappings: [{ kind: "system", source_id: "source-member", nexum_row_id: "nexum-row", ownership: "owned", status: "created" }],
        snapshot_fetched_at: at, payload_digest: "a".repeat(64), checkpoint: { accepted: true, replayed: false, partial: true } });
    expect(JSON.stringify(summary)).not.toContain("private note must not be exposed");
    expect(summarizeTopologyWriteResponse({ createdSystems: 0, preservedSystems: 0, updatedSystems: 0, deletedSystems: 0,
      createdConnections: 0, preservedConnections: 0, updatedConnections: 0, deletedConnections: 0,
      createdSignatures: 0, preservedSignatures: 0, updatedSignatures: 0, deletedSignatures: 0, conflicts: [],
      checkpoint: { accepted: true, replayed: false, partial: false } }))
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
