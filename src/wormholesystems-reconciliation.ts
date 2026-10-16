import type { WormholeSystemsFixture } from "./wormholesystems-fixture.js";

export type WormholesystemsTopologyRequest = {
  schemaVersion: 2;
  sourceIdentity: string;
  snapshot: { complete: true; fetchedAt: string };
  systems: Array<{ sourceSystemId: string; eveSystemId: number; positionX?: number; positionY?: number }>;
  connections: Array<{ sourceConnectionId: string; fromSourceSystemId: string; toSourceSystemId: string;
    sourceSignatureId: string | null; targetSignatureId: string | null;
    connection_type: "standard" | "gate" | "jumpgate" | "cyno"; ship_size?: "small" | "medium" | "large" | "xl" }>;
  signatures: Array<{ sourceSignatureId: string; sourceSystemId: string; sigId: string;
    sourceConnectionId: string | null;
    sigType: "data" | "relic" | "gas" | "ore" | "combat" | "wormhole" | "ghost" | "unknown"; whType: string }>;
};

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord => !!value && typeof value === "object" && !Array.isArray(value);
const safeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const validTime = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const approvedMaxSnapshotAgeMs = 60_000;
const sourceCategoryTypes = new Map<string, "data" | "relic" | "combat" | "gas" | "ore" | "wormhole">([
  ["Wormhole", "wormhole"], ["Data Site", "data"], ["Relic Site", "relic"], ["Combat Site", "combat"], ["Gas Site", "gas"], ["Ore Site", "ore"],
]);

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
  if (Object.keys(input).some(key => !["schemaVersion", "sourceIdentity", "snapshot", "systems", "connections", "signatures"].includes(key)))
    blockers.push("request: contains an unsupported field");
  if (input.schemaVersion !== 2) blockers.push("schemaVersion: complete signature-inclusive version 2 is required");
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
    const positionXUnavailable = value.positionX === undefined || value.positionX === null;
    const positionYUnavailable = value.positionY === undefined || value.positionY === null;
    const positionPairUnavailable = positionXUnavailable && positionYUnavailable;
    const positionPairValid = coordinate(value.positionX) && coordinate(value.positionY);
    if (!positionPairUnavailable && !positionPairValid) {
      if (!coordinate(value.positionX)) blockers.push(`${path}.positionX: verified source-owned map position is unavailable`);
      if (!coordinate(value.positionY)) blockers.push(`${path}.positionY: verified source-owned map position is unavailable`);
    }
    if (safeId(value.sourceSystemId)) {
      if (sourceSystems.has(value.sourceSystemId)) blockers.push(`${path}.sourceSystemId: duplicate source member ID`);
      sourceSystems.add(value.sourceSystemId);
    }
    if (Number.isSafeInteger(value.eveSystemId)) {
      if (eveSystems.has(Number(value.eveSystemId))) blockers.push(`${path}.eveSystemId: duplicate EVE system ID`);
      eveSystems.add(Number(value.eveSystemId));
    }
    if (safeId(value.sourceSystemId) && Number.isSafeInteger(value.eveSystemId) && (positionPairValid || positionPairUnavailable))
      systems.push({ sourceSystemId: value.sourceSystemId, eveSystemId: Number(value.eveSystemId),
        ...(positionPairValid ? { positionX: value.positionX as number, positionY: value.positionY as number } : {}) });
  });

  const connectionIds = new Set<string>();
  const connections: WormholesystemsTopologyRequest["connections"] = [];
  if (!Array.isArray(input.connections) || input.connections.length > 2_000) blockers.push("connections: validated bounded source-connection records are required");
  else input.connections.forEach((value, index) => {
    const path = `connections[${index}]`;
    if (!record(value)) { blockers.push(`${path}: expected a validated source-connection record`); return; }
    if (Object.keys(value).some(key => !["sourceConnectionId", "fromSourceSystemId", "toSourceSystemId", "sourceSignatureId", "targetSignatureId", "connection_type", "ship_size"].includes(key)))
      blockers.push(`${path}: contains an unsupported field`);
    if (!safeId(value.sourceConnectionId)) blockers.push(`${path}.sourceConnectionId: validated source connection ID is required`);
    if (!safeId(value.fromSourceSystemId) || !sourceSystems.has(String(value.fromSourceSystemId))) blockers.push(`${path}.fromSourceSystemId: validated in-scope source member ID is required`);
    if (!safeId(value.toSourceSystemId) || !sourceSystems.has(String(value.toSourceSystemId))) blockers.push(`${path}.toSourceSystemId: validated in-scope source member ID is required`);
    if (value.fromSourceSystemId === value.toSourceSystemId) blockers.push(`${path}: source connection endpoints must differ`);
    for (const key of ["sourceSignatureId", "targetSignatureId"] as const)
      if (value[key] !== null && !safeId(value[key])) blockers.push(`${path}.${key}: expected a validated source signature ID or null`);
    if (!(value.connection_type === "standard" || value.connection_type === "gate" || value.connection_type === "jumpgate" || value.connection_type === "cyno"))
      blockers.push(`${path}.connection_type: validated source connection type is unavailable`);
    if (value.ship_size !== undefined && !(value.ship_size === "small" || value.ship_size === "medium" || value.ship_size === "large" || value.ship_size === "xl"))
      blockers.push(`${path}.ship_size: validated source connection size is unavailable`);
    if (safeId(value.sourceConnectionId)) {
      if (connectionIds.has(value.sourceConnectionId)) blockers.push(`${path}.sourceConnectionId: duplicate source connection ID`);
      connectionIds.add(value.sourceConnectionId);
    }
    if (safeId(value.sourceConnectionId) && safeId(value.fromSourceSystemId) && safeId(value.toSourceSystemId) &&
      value.fromSourceSystemId !== value.toSourceSystemId && sourceSystems.has(value.fromSourceSystemId) && sourceSystems.has(value.toSourceSystemId) &&
      (value.connection_type === "standard" || value.connection_type === "gate" || value.connection_type === "jumpgate" || value.connection_type === "cyno") &&
      (value.ship_size === undefined || value.ship_size === "small" || value.ship_size === "medium" || value.ship_size === "large" || value.ship_size === "xl") &&
      (value.sourceSignatureId === null || safeId(value.sourceSignatureId)) &&
      (value.targetSignatureId === null || safeId(value.targetSignatureId)))
      connections.push({ sourceConnectionId: value.sourceConnectionId, fromSourceSystemId: value.fromSourceSystemId,
        toSourceSystemId: value.toSourceSystemId, sourceSignatureId: value.sourceSignatureId as string | null,
        targetSignatureId: value.targetSignatureId as string | null, connection_type: value.connection_type,
        ...(value.ship_size === undefined ? {} : { ship_size: value.ship_size }) });
  });

  const signatures: WormholesystemsTopologyRequest["signatures"] = [];
  const sourceSignatureIds = new Set<string>();
  const sourceSignatureById = new Map<string, WormholesystemsTopologyRequest["signatures"][number]>();
  if (!Array.isArray(input.signatures) || input.signatures.length > 200_000)
    blockers.push("signatures: validated bounded source-signature records are required");
  else input.signatures.forEach((value, index) => {
    const path = `signatures[${index}]`;
    if (!record(value)) { blockers.push(`${path}: expected a validated source-signature record`); return; }
    if (Object.keys(value).some(key => !["sourceSignatureId", "sourceSystemId", "sourceConnectionId", "sigId", "sigType", "whType"].includes(key)))
      blockers.push(`${path}: contains an unsupported field`);
    if (!safeId(value.sourceSignatureId)) blockers.push(`${path}.sourceSignatureId: validated source signature resource ID is required`);
    if (!safeId(value.sourceSystemId) || !sourceSystems.has(String(value.sourceSystemId)))
      blockers.push(`${path}.sourceSystemId: validated in-scope source member ID is required`);
    if (value.sourceConnectionId !== null && !safeId(value.sourceConnectionId))
      blockers.push(`${path}.sourceConnectionId: expected a validated source connection ID or null`);
    if (typeof value.sigId !== "string" || value.sigId.length > 64 || /[\u0000-\u001f\u007f]/.test(value.sigId))
      blockers.push(`${path}.sigId: expected the exact assigned source code or an empty unassigned code`);
    if (!(value.sigType === "data" || value.sigType === "relic" || value.sigType === "gas" || value.sigType === "ore" ||
      value.sigType === "combat" || value.sigType === "wormhole" || value.sigType === "ghost" || value.sigType === "unknown"))
      blockers.push(`${path}.sigType: mapped Nexum signature category is required`);
    if (typeof value.whType !== "string" || value.whType.length > 128 || /[\u0000-\u001f\u007f]/.test(value.whType))
      blockers.push(`${path}.whType: exact evidenced wormhole code or empty value is required`);
    if (safeId(value.sourceSignatureId)) {
      if (sourceSignatureIds.has(value.sourceSignatureId)) blockers.push(`${path}.sourceSignatureId: duplicate source signature resource ID`);
      sourceSignatureIds.add(value.sourceSignatureId);
    }
    if (safeId(value.sourceSignatureId) && safeId(value.sourceSystemId) && sourceSystems.has(value.sourceSystemId) &&
        (value.sourceConnectionId === null || safeId(value.sourceConnectionId)) &&
        typeof value.sigId === "string" && value.sigId.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value.sigId) &&
        (value.sigType === "data" || value.sigType === "relic" || value.sigType === "gas" || value.sigType === "ore" ||
         value.sigType === "combat" || value.sigType === "wormhole" || value.sigType === "ghost" || value.sigType === "unknown") &&
        typeof value.whType === "string" && value.whType.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value.whType)) {
      const signature: WormholesystemsTopologyRequest["signatures"][number] = { sourceSignatureId: value.sourceSignatureId,
        sourceSystemId: value.sourceSystemId, sourceConnectionId: value.sourceConnectionId as string | null, sigId: value.sigId,
        sigType: value.sigType as WormholesystemsTopologyRequest["signatures"][number]["sigType"], whType: value.whType };
      signatures.push(signature);
      sourceSignatureById.set(signature.sourceSignatureId, signature);
    }
  });
  const connectionById = new Map(connections.map(connection => [connection.sourceConnectionId, connection]));
  for (const [index, connection] of connections.entries()) {
    for (const key of ["sourceSignatureId", "targetSignatureId"] as const) {
      const id = connection[key];
      if (id !== null) {
        const signature = sourceSignatureById.get(id);
        if (!signature) blockers.push(`connections[${index}].${key}: source signature is absent from the complete snapshot projection`);
        else {
          const expectedSystem = key === "sourceSignatureId" ? connection.fromSourceSystemId : connection.toSourceSystemId;
          if (signature.sourceSystemId !== expectedSystem)
            blockers.push(`connections[${index}].${key}: source signature scanner member contradicts the connection endpoint`);
        }
      }
    }
  }
  for (const [index, signature] of signatures.entries()) {
    if (signature.sourceConnectionId === null) continue;
    const connection = connectionById.get(signature.sourceConnectionId);
    if (!connection) {
      blockers.push(`signatures[${index}].sourceConnectionId: source connection is absent from the complete snapshot projection`);
      continue;
    }
    if (signature.sourceSystemId === connection.fromSourceSystemId) {
      if (connection.sourceSignatureId !== signature.sourceSignatureId)
        blockers.push(`signatures[${index}].sourceConnectionId: source-side edge signature reference contradicts the explicit source association`);
    } else if (signature.sourceSystemId === connection.toSourceSystemId) {
      if (connection.targetSignatureId !== signature.sourceSignatureId)
        blockers.push(`signatures[${index}].sourceConnectionId: target-side edge signature reference contradicts the explicit source association`);
    } else blockers.push(`signatures[${index}].sourceConnectionId: scanner member is not an endpoint of the source connection`);
  }

  if (blockers.length) return { blockers: [...new Set(blockers)] };
  return { request: { schemaVersion: 2, sourceIdentity: input.sourceIdentity as string,
    snapshot: { complete: true, fetchedAt: new Date(Date.parse(snapshot.fetchedAt as string)).toISOString() }, systems, connections, signatures }, blockers: [] };
}

/** Build the only complete, deletion-authorizing request from a validated source fixture. */
export function topologyProjectionFromFixture(fixture: WormholeSystemsFixture): { candidate: UnknownRecord; blockers: string[]; diagnostics: string[] } {
  const blockers: string[] = [];
  const diagnostics: string[] = [];
  const maxDiagnostics = 100;
  let omittedDiagnostics = 0;
  const addDiagnostic = (message: string) => {
    if (diagnostics.length < maxDiagnostics - 1) diagnostics.push(message);
    else omittedDiagnostics++;
  };
  const evidence = fixture.topologyEvidence;
  if (evidence) {
    if (evidence.systems.length !== fixture.systems.length)
      blockers.push("systems: topology projection does not contain every validated source member");
    if (evidence.connections.length !== fixture.connections.length)
      blockers.push("connections: topology projection does not contain every validated source connection");
    const systems = evidence.systems.map(system => ({ sourceSystemId: system.sourceSystemId, eveSystemId: system.eveSystemId,
      ...(system.positionX == null && system.positionY == null ? {} : { positionX: system.positionX, positionY: system.positionY }) }))
      .sort((a, b) => a.sourceSystemId.localeCompare(b.sourceSystemId));
    const sourceByEve = new Map(evidence.systems.map(system => [system.eveSystemId, system.sourceSystemId]));
    const signaturesByConnectionAndEve = new Map<string, string[]>();
    for (const signature of fixture.signatures) {
      if (signature.sourceConnectionId === null || signature.sourceSignatureId === null) continue;
      const key = `${signature.sourceConnectionId}\u0000${signature.scannerEveSystemId}`;
      signaturesByConnectionAndEve.set(key, [...(signaturesByConnectionAndEve.get(key) ?? []), signature.sourceSignatureId]);
    }
    const connections = evidence.connections.map(connection => {
      const sourceConnection = fixture.connections.find(row => row.sourceConnectionId === connection.sourceConnectionId);
      const sourceType = connection.connectionType;
      const connectionType = sourceType === "wormhole" ? "standard" : sourceType === "stargate" ? "gate" : undefined;
      if (!connectionType) blockers.push(`connections[${connection.sourceConnectionId}].type: unsupported source-present connection type cannot be projected`);
      const size = connection.size === "frigate" ? "small" : connection.size === "medium" ? "medium"
        : connection.size === "large" ? "large" : connection.size === "xlarge" ? "xl" : undefined;
      if (!size) addDiagnostic(`connections[${connection.sourceConnectionId}].ship_size: source size is absent or unsupported; Nexum default may be used on creation`);
      const fromEveSystemId = sourceConnection?.fromEveSystemId;
      const toEveSystemId = sourceConnection?.toEveSystemId;
      const fromCandidates = fromEveSystemId === undefined ? [] : signaturesByConnectionAndEve.get(`${connection.sourceConnectionId}\u0000${fromEveSystemId}`) ?? [];
      const toCandidates = toEveSystemId === undefined ? [] : signaturesByConnectionAndEve.get(`${connection.sourceConnectionId}\u0000${toEveSystemId}`) ?? [];
      return { sourceConnectionId: connection.sourceConnectionId, fromSourceSystemId: connection.fromSourceSystemId,
        toSourceSystemId: connection.toSourceSystemId,
        sourceSignatureId: fromCandidates.length === 1 ? fromCandidates[0] : null,
        targetSignatureId: toCandidates.length === 1 ? toCandidates[0] : null,
        connection_type: connectionType,
        ...(size ? { ship_size: size } : {}) };
    }).sort((a, b) => a.sourceConnectionId.localeCompare(b.sourceConnectionId));
    if (fixture.schemaVersion !== 3 || fixture.sourceKind !== "wormholesystems" || !Array.isArray(fixture.sourceSignatureEvidence))
      blockers.push("signatures: a newly fetched version-3 classification snapshot is required for data writes");
    const evidenceById = new Map((fixture.sourceSignatureEvidence ?? []).map(signature => [signature.sourceSignatureId, signature]));
    const signatures = fixture.signatures.map((signature, index) => {
      const sourceSignatureId = signature.sourceSignatureId;
      const sourceSystemId = sourceByEve.get(signature.scannerEveSystemId);
      if (!sourceSignatureId) blockers.push(`signatures[${index}].sourceSignatureId: source signature resource ID is unavailable`);
      if (!sourceSystemId) blockers.push(`signatures[${index}].sourceSystemId: scanner is not a validated source member`);
      const classification = sourceSignatureId ? evidenceById.get(sourceSignatureId) : undefined;
      if (!classification) blockers.push(`signatures[${index}].classification: validated source classification evidence is unavailable`);
      else {
        if (!Object.prototype.hasOwnProperty.call(classification, "signatureCode"))
          blockers.push(`signatures[${sourceSignatureId}].signature_id: source code assignment was not explicitly captured`);
      }
      const category = classification?.signatureCategoryName;
      const directWormholeId = classification?.wormholeId;
      const nestedWormholeId = classification?.nestedWormholeId;
      const hasDirectWormholeId = directWormholeId !== undefined && directWormholeId !== null && directWormholeId !== "";
      const hasNestedWormholeId = nestedWormholeId !== undefined && nestedWormholeId !== null && nestedWormholeId !== "";
      const hasWormholeIdEvidence = hasDirectWormholeId || hasNestedWormholeId;
      const hasWormholeRelation = hasDirectWormholeId && hasNestedWormholeId && String(directWormholeId) === String(nestedWormholeId);
      const wormholeName = classification?.wormholeName;
      const sigType = typeof category === "string" ? sourceCategoryTypes.get(category) ?? "unknown" : "unknown";
      const hasWormholeName = typeof wormholeName === "string" && wormholeName.length > 0;
      const whType = category === "Wormhole" && hasWormholeRelation && hasWormholeName
        ? wormholeName : "";
      if (category === "Wormhole" && ((hasWormholeIdEvidence && !hasWormholeRelation) || (hasWormholeName && !hasWormholeRelation)))
        blockers.push(`signatures[${sourceSignatureId}].wormhole_id: Wormhole classification has a partial or contradictory relation/name`);
      if (["Data Site", "Relic Site", "Combat Site", "Gas Site", "Ore Site"].includes(String(category)) &&
          ((directWormholeId !== undefined && directWormholeId !== null) || (nestedWormholeId !== undefined && nestedWormholeId !== null) ||
            (typeof wormholeName === "string" && wormholeName.length > 0)))
        blockers.push(`signatures[${sourceSignatureId}].wormhole_id: wormhole relation contradicts the validated non-wormhole category`);
      if (sigType === "unknown")
        addDiagnostic(`signatures[${sourceSignatureId}]: source category is absent or unsupported; projected as sigType "unknown" with empty whType (type_unmapped)`);
      else if (category === "Wormhole" && hasWormholeRelation && !whType)
        addDiagnostic(`signatures[${sourceSignatureId}]: validated Wormhole category has no non-empty related name; projected with empty whType`);
      return { sourceSignatureId: sourceSignatureId ?? "", sourceSystemId: sourceSystemId ?? "",
        sourceConnectionId: signature.sourceConnectionId,
        sigId: signature.signatureCode ?? "", sigType, whType };
    }).sort((a, b) => a.sourceSignatureId.localeCompare(b.sourceSignatureId));
    if (signatures.length !== fixture.signatures.length)
      blockers.push("signatures: projection cardinality differs from the complete source signature collection");
    if (omittedDiagnostics) diagnostics.push(`projection: ${omittedDiagnostics} additional diagnostic(s) omitted by the ${maxDiagnostics}-item bound`);
    return { candidate: { schemaVersion: 2, sourceIdentity: fixture.sourceIdentity,
      snapshot: { complete: evidence.complete, fetchedAt: fixture.fetchedAt }, systems, connections, signatures },
      blockers: [...new Set(blockers)], diagnostics };
  }
  const systems = fixture.systems.map(system => ({ sourceSystemId: system.sourceSystemId, eveSystemId: system.eveSolarSystemId }));
  const connections = fixture.connections.map(connection => ({ sourceConnectionId: connection.sourceConnectionId,
    fromSourceSystemId: fixture.systems.find(system => system.eveSolarSystemId === connection.fromEveSystemId)?.sourceSystemId,
    toSourceSystemId: fixture.systems.find(system => system.eveSolarSystemId === connection.toEveSystemId)?.sourceSystemId,
    connection_type: undefined, ship_size: undefined }));
  return { candidate: { schemaVersion: 2, sourceIdentity: fixture.sourceIdentity,
    snapshot: { complete: false, fetchedAt: fixture.fetchedAt }, systems, connections, signatures: [] },
    blockers: ["topology evidence: complete validated source topology fields are unavailable"], diagnostics: [] };
}

export function topologyCandidateFromFixture(fixture: WormholeSystemsFixture): UnknownRecord {
  return topologyProjectionFromFixture(fixture).candidate;
}

export type TopologyWriteDiagnostics = {
  request_status: "succeeded";
  status: "completed";
  reconciliation_status: "applied" | "partial" | "unchanged" | "unknown";
  created_systems: number | null; updated_systems: number | null; deleted_systems: number | null; preserved_systems: number | null;
  created_connections: number | null; updated_connections: number | null; deleted_connections: number | null; preserved_connections: number | null;
  created_signatures: number | null; updated_signatures: number | null; deleted_signatures: number | null; preserved_signatures: number | null;
  conflict_count: number | null;
  conflicts: Array<{ kind?: string; source_id?: string; nexum_row_id?: string; field?: string; reason?: string }>;
  conflicts_omitted: number;
  mappings: Array<{ kind: string; source_id: string; nexum_row_id: string; ownership?: "owned" | "preserved"; status?: string }>;
  mappings_omitted: number;
  snapshot_fetched_at: string | null;
  payload_digest: string | null;
  checkpoint: { accepted: boolean | null; replayed: boolean | null; partial: boolean | null } | null;
};

function safeDiagnosticText(value: unknown, max = 512): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function sanitizedItems(value: unknown, kind?: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  const append = (item: unknown, fallbackKind?: string) => {
    if (!record(item)) return;
    const inferredKind = item.sourceSystemId !== undefined ? "system" : item.sourceConnectionId !== undefined ? "connection"
      : item.sourceSignatureId !== undefined ? "signature" : undefined;
    const candidateKind = safeDiagnosticText(item.kind ?? fallbackKind ?? inferredKind, 32);
    const itemKind = candidateKind && ["system", "connection", "signature", "map_system", "map_connection", "map_signature"].includes(candidateKind)
      ? candidateKind : undefined;
    const sourceId = safeDiagnosticText(item.sourceItemId ?? item.source_id ?? item.sourceId ?? item.itemId ??
      item.sourceSystemId ?? item.sourceConnectionId ?? item.sourceSignatureId, 256);
    const rowId = safeDiagnosticText(item.nexumRowId ?? item.rowId ?? item.nexum_row_id ?? item.nexumId ??
      item.nexumSystemId ?? item.nexumConnectionId ?? item.nexumSignatureId, 256);
    const ownership = item.ownership === "owned" || item.ownership === "preserved" ? item.ownership : undefined;
    const candidateStatus = safeDiagnosticText(item.status, 32);
    const status = candidateStatus && ["created", "preserved", "updated", "deleted", "unchanged", "conflict", "owned", "mapped", "type_unmapped"].includes(candidateStatus)
      ? candidateStatus : undefined;
    const field = safeDiagnosticText(item.field, 64);
    const reason = safeDiagnosticText(item.reason, 512);
    const row: Record<string, string> = {};
    if (itemKind) row.kind = itemKind;
    if (sourceId) row.source_id = sourceId;
    if (rowId) row.nexum_row_id = rowId;
    if (ownership) row.ownership = ownership;
    if (status) row.status = status;
    if (field) row.field = field;
    if (reason) row.reason = "Nexum reported a row-level reconciliation conflict";
    if (Object.keys(row).length) rows.push(row);
  };
  if (Array.isArray(value)) value.forEach(item => append(item, kind));
  else if (record(value)) {
    for (const group of ["systems", "connections", "signatures"] as const)
      if (Array.isArray(value[group])) (value[group] as unknown[]).forEach(item => append(item, group.slice(0, -1)));
  }
  return rows;
}

/** Keep successful HTTP submission distinct from the row-level reconciliation result. */
export function summarizeTopologyWriteResponse(value: unknown): TopologyWriteDiagnostics {
  const count = (key: string): number | null => record(value) && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0
    ? Number(value[key]) : null;
  const rawConflicts = record(value) && Array.isArray(value.conflicts) ? value.conflicts : undefined;
  const rawMappings = record(value) ? value.mappings ?? value.sourceToNexum ?? value.source_to_nexum : undefined;
  const conflicts = sanitizedItems(rawConflicts).slice(0, 256).map(item => ({
    ...(item.kind ? { kind: item.kind } : {}), ...(item.source_id ? { source_id: item.source_id } : {}),
    ...(item.nexum_row_id ? { nexum_row_id: item.nexum_row_id } : {}), ...(item.field ? { field: item.field } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
  }));
  const mappings = sanitizedItems(rawMappings).filter(item => item.kind && item.source_id && item.nexum_row_id).slice(0, 1_000).map(item => ({
    kind: item.kind!, source_id: item.source_id!, nexum_row_id: item.nexum_row_id!,
    ...(item.ownership === "owned" || item.ownership === "preserved" ? { ownership: item.ownership as "owned" | "preserved" } : {}),
    ...(item.status ? { status: item.status } : {}),
  }));
  const counts = {
    created_systems: count("createdSystems"), updated_systems: count("updatedSystems"),
    deleted_systems: count("deletedSystems"), preserved_systems: count("preservedSystems"),
    created_connections: count("createdConnections"), updated_connections: count("updatedConnections"),
    deleted_connections: count("deletedConnections"), preserved_connections: count("preservedConnections"),
    created_signatures: count("createdSignatures"), updated_signatures: count("updatedSignatures"),
    deleted_signatures: count("deletedSignatures"), preserved_signatures: count("preservedSignatures"),
    conflict_count: rawConflicts?.length ?? null,
  };
  const countValues = Object.values(counts);
  const checkpointInput = record(value) && record(value.checkpoint) ? value.checkpoint : undefined;
  const checkpointRecognized = checkpointInput && ["accepted", "replayed", "partial"].every(key =>
    typeof checkpointInput[key] === "boolean");
  const checkpoint = checkpointRecognized ? { accepted: checkpointInput.accepted as boolean,
    replayed: checkpointInput.replayed as boolean, partial: checkpointInput.partial as boolean } : null;
  const acknowledged = checkpoint?.accepted === true || checkpoint?.replayed === true;
  const reconciliationStatus: TopologyWriteDiagnostics["reconciliation_status"] = !acknowledged ? "unknown"
    : counts.conflict_count !== null && counts.conflict_count > 0 || checkpoint?.partial === true
      ? "partial" : countValues.some(item => item === null)
        ? "unknown" : counts.created_systems! + counts.updated_systems! + counts.deleted_systems! + counts.created_connections! +
        counts.updated_connections! + counts.deleted_connections! + counts.created_signatures! + counts.updated_signatures! + counts.deleted_signatures! > 0 ? "applied" : "unchanged";
  const fetchedAt = record(value) ? safeDiagnosticText(value.snapshotFetchedAt ?? value.snapshot_fetched_at, 64) : undefined;
  const payloadDigest = record(value) ? safeDiagnosticText(value.payloadDigest ?? value.payload_digest, 128) : undefined;
  return { request_status: "succeeded", status: "completed", reconciliation_status: reconciliationStatus, ...counts,
    conflicts, conflicts_omitted: Math.max(0, (rawConflicts?.length ?? 0) - conflicts.length),
    mappings, mappings_omitted: Math.max(0, sanitizedItems(rawMappings).filter(item => item.kind && item.source_id && item.nexum_row_id).length - mappings.length),
    snapshot_fetched_at: fetchedAt && validTime(fetchedAt) ? new Date(Date.parse(fetchedAt)).toISOString() : null,
    payload_digest: payloadDigest && /^(?:sha256:)?[a-f0-9]{64}$/i.test(payloadDigest) ? payloadDigest : null, checkpoint };
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
