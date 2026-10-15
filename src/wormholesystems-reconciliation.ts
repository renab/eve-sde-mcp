import type { WormholeSystemsFixture } from "./wormholesystems-fixture.js";

export type WormholesystemsTopologyRequest = {
  sourceIdentity: string;
  snapshot: { complete: true; fetchedAt: string };
  systems: Array<{ sourceSystemId: string; eveSystemId: number; positionX: number; positionY: number }>;
  connections: Array<{ sourceConnectionId: string; fromSourceSystemId: string; toSourceSystemId: string;
    connection_type: "standard" | "gate" | "jumpgate" | "cyno"; ship_size: "small" | "medium" | "large" | "xl" }>;
};

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord => !!value && typeof value === "object" && !Array.isArray(value);
const safeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const validTime = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const approvedMaxSnapshotAgeMs = 60_000;

function validSourceIdentity(value: unknown): value is string {
  if (!safeId(value) || !value.startsWith("wormholesystems:")) return false;
  try {
    const tuple: unknown = JSON.parse(value.slice("wormholesystems:".length));
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string" || !safeId(tuple[1])) return false;
    const origin = new URL(tuple[0]);
    return (origin.protocol === "https:" || origin.protocol === "http:") && origin.origin === tuple[0] &&
      value === `wormholesystems:${JSON.stringify([tuple[0], tuple[1]])}`;
  } catch { return false; }
}

/** Validate the exact Nexum topology request contract without interpreting raw source fields. */
export function validateWormholesystemsTopologyRequest(input: unknown, now = Date.now(), maxSnapshotAgeMs = approvedMaxSnapshotAgeMs): {
  request?: WormholesystemsTopologyRequest; blockers: string[];
} {
  const blockers: string[] = [];
  if (!Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs <= 0)
    blockers.push("snapshot.fetchedAt: valid runtime staleness policy is unavailable");
  if (!record(input)) return { blockers: ["request: expected an object"] };
  if (Object.keys(input).some(key => !["sourceIdentity", "snapshot", "systems", "connections"].includes(key)))
    blockers.push("request: contains an unsupported field");
  if (!validSourceIdentity(input.sourceIdentity)) blockers.push("sourceIdentity: missing or invalid canonical WormholeSystems identity");

  const snapshot = record(input.snapshot) ? input.snapshot : {};
  if (!record(input.snapshot)) blockers.push("snapshot: validated source completeness/freshness evidence is unavailable");
  if (Object.keys(snapshot).some(key => !["complete", "fetchedAt"].includes(key)))
    blockers.push("snapshot: contains an unsupported field");
  if (snapshot.complete !== true) blockers.push("snapshot.complete: complete source-snapshot semantics are unverified");
  if (!validTime(snapshot.fetchedAt)) blockers.push("snapshot.fetchedAt: validated retrieval timestamp is unavailable");
  if (validTime(snapshot.fetchedAt)) {
    const time = Date.parse(snapshot.fetchedAt);
    if (time > now || now - time > maxSnapshotAgeMs) blockers.push("snapshot.fetchedAt: missing, future-dated, or stale");
  }

  const sourceSystems = new Set<string>();
  const eveSystems = new Set<number>();
  const systems: WormholesystemsTopologyRequest["systems"] = [];
  if (!Array.isArray(input.systems) || input.systems.length > 100) blockers.push("systems: validated bounded source-system records are required");
  else input.systems.forEach((value, index) => {
    const path = `systems[${index}]`;
    if (!record(value)) { blockers.push(`${path}: expected a validated source-system record`); return; }
    if (Object.keys(value).some(key => !["sourceSystemId", "eveSystemId", "positionX", "positionY"].includes(key)))
      blockers.push(`${path}: contains an unsupported field`);
    if (!safeId(value.sourceSystemId)) blockers.push(`${path}.sourceSystemId: validated source member ID is required`);
    if (!Number.isSafeInteger(value.eveSystemId) || Number(value.eveSystemId) < 1 || Number(value.eveSystemId) > 2_147_483_647)
      blockers.push(`${path}.eveSystemId: validated EVE solar-system ID is required`);
    if (!coordinate(value.positionX)) blockers.push(`${path}.positionX: verified source-owned map position is unavailable`);
    if (!coordinate(value.positionY)) blockers.push(`${path}.positionY: verified source-owned map position is unavailable`);
    if (safeId(value.sourceSystemId)) {
      if (sourceSystems.has(value.sourceSystemId)) blockers.push(`${path}.sourceSystemId: duplicate source member ID`);
      sourceSystems.add(value.sourceSystemId);
    }
    if (Number.isSafeInteger(value.eveSystemId)) {
      if (eveSystems.has(Number(value.eveSystemId))) blockers.push(`${path}.eveSystemId: duplicate EVE system ID`);
      eveSystems.add(Number(value.eveSystemId));
    }
    if (safeId(value.sourceSystemId) && Number.isSafeInteger(value.eveSystemId) && coordinate(value.positionX) && coordinate(value.positionY))
      systems.push({ sourceSystemId: value.sourceSystemId, eveSystemId: Number(value.eveSystemId), positionX: value.positionX, positionY: value.positionY });
  });

  const connectionIds = new Set<string>();
  const connections: WormholesystemsTopologyRequest["connections"] = [];
  if (!Array.isArray(input.connections) || input.connections.length > 2_000) blockers.push("connections: validated bounded source-connection records are required");
  else input.connections.forEach((value, index) => {
    const path = `connections[${index}]`;
    if (!record(value)) { blockers.push(`${path}: expected a validated source-connection record`); return; }
    if (Object.keys(value).some(key => !["sourceConnectionId", "fromSourceSystemId", "toSourceSystemId", "connection_type", "ship_size"].includes(key)))
      blockers.push(`${path}: contains an unsupported field`);
    if (!safeId(value.sourceConnectionId)) blockers.push(`${path}.sourceConnectionId: validated source connection ID is required`);
    if (!safeId(value.fromSourceSystemId) || !sourceSystems.has(String(value.fromSourceSystemId))) blockers.push(`${path}.fromSourceSystemId: validated in-scope source member ID is required`);
    if (!safeId(value.toSourceSystemId) || !sourceSystems.has(String(value.toSourceSystemId))) blockers.push(`${path}.toSourceSystemId: validated in-scope source member ID is required`);
    if (value.fromSourceSystemId === value.toSourceSystemId) blockers.push(`${path}: source connection endpoints must differ`);
    if (!(value.connection_type === "standard" || value.connection_type === "gate" || value.connection_type === "jumpgate" || value.connection_type === "cyno"))
      blockers.push(`${path}.connection_type: validated source connection type is unavailable`);
    if (!(value.ship_size === "small" || value.ship_size === "medium" || value.ship_size === "large" || value.ship_size === "xl"))
      blockers.push(`${path}.ship_size: validated source connection size is unavailable`);
    if (safeId(value.sourceConnectionId)) {
      if (connectionIds.has(value.sourceConnectionId)) blockers.push(`${path}.sourceConnectionId: duplicate source connection ID`);
      connectionIds.add(value.sourceConnectionId);
    }
    if (safeId(value.sourceConnectionId) && safeId(value.fromSourceSystemId) && safeId(value.toSourceSystemId) &&
      value.fromSourceSystemId !== value.toSourceSystemId && sourceSystems.has(value.fromSourceSystemId) && sourceSystems.has(value.toSourceSystemId) &&
      (value.connection_type === "standard" || value.connection_type === "gate" || value.connection_type === "jumpgate" || value.connection_type === "cyno") &&
      (value.ship_size === "small" || value.ship_size === "medium" || value.ship_size === "large" || value.ship_size === "xl"))
      connections.push({ sourceConnectionId: value.sourceConnectionId, fromSourceSystemId: value.fromSourceSystemId,
        toSourceSystemId: value.toSourceSystemId, connection_type: value.connection_type, ship_size: value.ship_size });
  });

  if (blockers.length) return { blockers: [...new Set(blockers)] };
  return { request: { sourceIdentity: input.sourceIdentity as string,
    snapshot: { complete: true, fetchedAt: new Date(Date.parse(snapshot.fetchedAt as string)).toISOString() }, systems, connections }, blockers: [] };
}

/** Current adapter fields are intentionally not promoted from opaque metadata to write authority. */
export function topologyCandidateFromFixture(fixture: WormholeSystemsFixture): UnknownRecord {
  const evidence = fixture.topologyEvidence;
  if (evidence) return { sourceIdentity: fixture.sourceIdentity,
    snapshot: { complete: evidence.complete, fetchedAt: fixture.fetchedAt }, systems: evidence.systems,
    connections: evidence.connections.map(connection => ({ sourceConnectionId: connection.sourceConnectionId,
      fromSourceSystemId: connection.fromSourceSystemId, toSourceSystemId: connection.toSourceSystemId,
      connection_type: connection.connectionType, ship_size: connection.size })) };
  const systems = fixture.systems.map(system => ({ sourceSystemId: system.sourceSystemId, eveSystemId: system.eveSolarSystemId,
    positionX: undefined, positionY: undefined }));
  const connections = fixture.connections.map(connection => ({ sourceConnectionId: connection.sourceConnectionId,
    fromSourceSystemId: fixture.systems.find(system => system.eveSolarSystemId === connection.fromEveSystemId)?.sourceSystemId,
    toSourceSystemId: fixture.systems.find(system => system.eveSolarSystemId === connection.toEveSystemId)?.sourceSystemId,
    connection_type: undefined, ship_size: undefined }));
  return { sourceIdentity: fixture.sourceIdentity,
    snapshot: { complete: false, fetchedAt: fixture.fetchedAt },
    systems, connections }; // Never pull aliases, positions, statuses or annotations out of opaque sourceMetadata.
}

export type TopologyWriteDiagnostics = {
  request_status: "succeeded";
  status: "completed";
  reconciliation_status: "applied" | "partial" | "unchanged" | "unknown";
  created_systems: number | null; updated_systems: number | null; deleted_systems: number | null; preserved_systems: number | null;
  created_connections: number | null; updated_connections: number | null; deleted_connections: number | null; preserved_connections: number | null;
  conflict_count: number | null;
};

/** Keep successful HTTP submission distinct from the row-level reconciliation result. */
export function summarizeTopologyWriteResponse(value: unknown): TopologyWriteDiagnostics {
  const count = (key: string): number | null => record(value) && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0
    ? Number(value[key]) : null;
  const counts = {
    created_systems: count("createdSystems"), updated_systems: count("updatedSystems"),
    deleted_systems: count("deletedSystems"), preserved_systems: count("preservedSystems"),
    created_connections: count("createdConnections"), updated_connections: count("updatedConnections"),
    deleted_connections: count("deletedConnections"), preserved_connections: count("preservedConnections"),
    conflict_count: record(value) && Array.isArray(value.conflicts) ? value.conflicts.length : null,
  };
  const countValues = Object.values(counts);
  const reconciliationStatus: TopologyWriteDiagnostics["reconciliation_status"] = countValues.some(item => item === null)
    ? "unknown" : counts.conflict_count! > 0 ? "partial"
      : counts.created_systems! + counts.updated_systems! + counts.deleted_systems! + counts.created_connections! +
        counts.updated_connections! + counts.deleted_connections! > 0 ? "applied" : "unchanged";
  return { request_status: "succeeded", status: "completed", reconciliation_status: reconciliationStatus, ...counts };
}

export type AllianceNoteInput = {
  fromSourceSystemId: unknown; toSourceSystemId: unknown;
  fromAlias: unknown; fromIsHome: unknown; toAlias: unknown; toIsHome: unknown;
  signatureCode: unknown; destinationClass: unknown; size: unknown;
  statusAnnotation?: unknown; knownStatusAnnotations: ReadonlySet<string>; reverse?: boolean;
};

export function renderAllianceNote(input: AllianceNoteInput): { note?: string; blockers: string[] } {
  const blockers: string[] = [];
  if (!safeId(input.fromSourceSystemId)) blockers.push("fromSourceSystemId: validated source member ID is required");
  if (!safeId(input.toSourceSystemId)) blockers.push("toSourceSystemId: validated source member ID is required");
  if (input.fromSourceSystemId === input.toSourceSystemId) blockers.push("source endpoints must differ");
  const alias = (value: unknown, isHome: unknown, name: string): string | undefined => {
    if (isHome === true) {
      if (value !== "0") { blockers.push(`${name}Alias: validated home alias 0 is required`); return undefined; }
      return "0";
    }
    if (isHome !== false) { blockers.push(`${name}IsHome: validated home identity is required`); return undefined; }
    if (typeof value !== "string" || value.length > 32 || !/^[1-9]\d*$/.test(value)) {
      blockers.push(`${name}Alias: validated positive decimal branch alias is required`); return undefined;
    }
    return value;
  };
  const fromAlias = alias(input.fromAlias, input.fromIsHome, "from");
  const toAlias = alias(input.toAlias, input.toIsHome, "to");
  if (typeof input.signatureCode !== "string" || !/^[A-Za-z0-9]{3}-[A-Za-z0-9]{3}$/.test(input.signatureCode))
    blockers.push("signatureCode: validated source signature code is required");
  if (typeof input.destinationClass !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(input.destinationClass))
    blockers.push("destinationClass: validated destination class is required");
  if (!(input.size === "small" || input.size === "medium" || input.size === "large")) blockers.push("size: validated wormhole size is required");
  const annotation = input.statusAnnotation;
  if (annotation !== undefined && (typeof annotation !== "string" || !input.knownStatusAnnotations.has(annotation)))
    blockers.push("statusAnnotation: annotation is not in the validated alliance status vocabulary");
  if (blockers.length || !fromAlias || !toAlias) return { blockers };
  const prefix = input.reverse ? ".." : ".";
  const note = `${prefix}${fromAlias}-${toAlias} ${input.signatureCode} ${input.destinationClass} ${input.size}${annotation ? ` ${annotation}` : ""}`;
  if (note.length > 1024) return { blockers: ["note: rendered alliance text exceeds the Nexum note bound"] };
  return { note, blockers: [] };
}

export function allianceNoteWriteEligibility(input: {
  rendered: ReturnType<typeof renderAllianceNote>;
  snapshotFresh: boolean;
  identityMatched: boolean;
  targetRowAvailable: boolean;
  currentNote: unknown;
  decisionBoundaryHeld: boolean;
}): { eligible: boolean; blockers: string[] } {
  const blockers = [...input.rendered.blockers];
  if (!input.rendered.note) blockers.push("desired note: validated alliance rendering is unavailable");
  if (!input.snapshotFresh) blockers.push("source snapshot: validated freshness and configuration evidence is unavailable");
  if (!input.identityMatched) blockers.push("Nexum identity: exact directional source-to-target match is unavailable");
  if (!input.targetRowAvailable) blockers.push("Nexum signature row: current target row is unavailable");
  if (!input.decisionBoundaryHeld) blockers.push("map decision boundary: write is not serialized with map changes");
  if (typeof input.currentNote !== "string") blockers.push("current note: cached note value is unknown");
  else if (input.currentNote !== "" && input.currentNote !== input.rendered.note)
    blockers.push("current note: non-empty manual note is preserved");
  const unique = [...new Set(blockers)];
  return { eligible: unique.length === 0, blockers: unique };
}
