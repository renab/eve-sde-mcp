import {
  normalizeWormholeSystemsFixture,
  type WormholeSystemsFixture,
} from "./wormholesystems-fixture.js";

export type SourceMapSystem = { id: string; solarSystemId: number };
export type SourceMapDetail = Record<string, unknown> & {
  id: string | number;
  map_solarsystems: unknown[];
  map_connections: unknown[];
};
export type AdapterIssue = { path: string; reason: string };
export type AdapterResult =
  | { ok: true; fixture: WormholeSystemsFixture; diagnostics: { systemCount: number; signatureCount: number; connectionCount: number; unknownStatusCount: number; skippedConnectionCount: number; opaqueMapConnectionCount: number; unmappedMapConnectionCount: number; auditRecordCount: number; sourceMapFieldNames: string[] } }
  | { ok: false; issues: AdapterIssue[] };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const opaque = (value: unknown, path: string, issues: AdapterIssue[]): string | null => {
  if ((typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) ||
      !String(value).trim() || String(value).length > 256 || /[\u0000-\u001f\u007f]/.test(String(value))) {
    issues.push({ path, reason: "expected a bounded opaque source identifier" });
    return null;
  }
  return String(value);
};
const eveId = (value: unknown, path: string, issues: AdapterIssue[]): number | null => {
  const parsed = typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1 || (parsed as number) > 2_147_483_647) {
    issues.push({ path, reason: "expected an explicit EVE solar-system ID" });
    return null;
  }
  return parsed as number;
};
const nullableOpaque = (value: unknown, path: string, issues: AdapterIssue[]): string | null => value == null ? null : opaque(value, path, issues);
const observedTime = (value: unknown, path: string, issues: AdapterIssue[]): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    issues.push({ path, reason: "expected a valid observed_at timestamp or null" });
    return null;
  }
  return value;
};
const isJson = (value: unknown, depth = 0): boolean => {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 20_000 && value.every(item => isJson(item, depth + 1));
  return record(value) && Object.keys(value).length <= 2_000 && Object.values(value).every(item => isJson(item, depth + 1));
};

/** Validate the source map envelope and the opaque map-row/EVE-ID namespaces. */
export function validateSourceMapDetail(value: unknown, expectedMapId: string): { detail?: SourceMapDetail; issues: AdapterIssue[] } {
  const issues: AdapterIssue[] = [];
  const body = record(value) && record(value.data) ? value.data : value;
  if (!record(body)) return { issues: [{ path: "$.data", reason: "expected map detail object" }] };
  const id = opaque(body.id, "$.data.id", issues);
  if (id !== expectedMapId) issues.push({ path: "$.data.id", reason: "map detail identity mismatch" });
  if (!Array.isArray(body.map_solarsystems) || body.map_solarsystems.length > 100)
    issues.push({ path: "$.data.map_solarsystems", reason: "expected at most 100 map solar-system records" });
  if (!Array.isArray(body.map_connections) || body.map_connections.length > 2_000)
    issues.push({ path: "$.data.map_connections", reason: "expected a bounded map connection array" });
  const mapRows = new Set<string>();
  if (Array.isArray(body.map_solarsystems)) body.map_solarsystems.forEach((row, index) => {
    const path = `$.data.map_solarsystems[${index}]`;
    if (!record(row)) { issues.push({ path, reason: "expected a source record" }); return; }
    const rowId = opaque(row.id, `${path}.id`, issues);
    const rowMapId = opaque(row.map_id, `${path}.map_id`, issues);
    eveId(row.solarsystem_id, `${path}.solarsystem_id`, issues);
    if (rowMapId !== expectedMapId) issues.push({ path: `${path}.map_id`, reason: "map solar-system row is outside selected map scope" });
    if (rowId && mapRows.has(rowId)) issues.push({ path: `${path}.id`, reason: "duplicate map solar-system identity" });
    if (rowId) mapRows.add(rowId);
  });
  if (!isJson(body)) issues.push({ path: "$.data", reason: "source map detail is not bounded JSON data" });
  return issues.length ? { issues } : { detail: body as SourceMapDetail, issues };
}

/** Normalize only confirmed resource identities; statuses and freshness stay opaque/unknown. */
export function normalizeSourceSnapshot(input: {
  mapId: string;
  canonicalMapId: string;
  sourceIdentity: string;
  revisionOrDigest: string;
  fetchedAt: string;
  detail: unknown;
  systemDetails: unknown[];
}): AdapterResult {
  const validated = validateSourceMapDetail(input.detail, input.mapId);
  const issues = [...validated.issues];
  if (!validated.detail) return { ok: false, issues };
  const detail = validated.detail;
  const observedAt = observedTime(detail.observed_at, "$.data.observed_at", issues);
  const mapSystems = detail.map_solarsystems as Array<Record<string, unknown>>;
  if (input.systemDetails.length !== mapSystems.length || input.systemDetails.length > 100)
    issues.push({ path: "$.systemDetails", reason: "map-system detail count does not match map scope" });

  const sourceSystemIds = new Map<string, number>();
  mapSystems.forEach((row, index) => {
    const path = `$.data.map_solarsystems[${index}]`;
    const rowId = opaque(row.id, `${path}.id`, issues);
    const rowMapId = opaque(row.map_id, `${path}.map_id`, issues);
    const eveSystemId = eveId(row.solarsystem_id, `${path}.solarsystem_id`, issues);
    if (!rowId || eveSystemId === null) return;
    if (rowMapId !== input.mapId) issues.push({ path: `${path}.map_id`, reason: "map solar-system row is outside selected map scope" });
    sourceSystemIds.set(rowId, eveSystemId);
  });

  type SourceConnection = {
    id: string;
    fromRowId: string;
    toRowId: string;
    value: Record<string, unknown>;
    path: string;
    relationshipResources: Array<{ value: Record<string, unknown>; path: string }>;
  };
  const connectionById = new Map<string, SourceConnection>();
  const rootConnectionIds = new Set<string>();
  const mapConnectionRows = detail.map_connections as unknown[];
  const addConnection = (value: unknown, path: string, allowNew = false): SourceConnection | null => {
    if (!record(value)) { issues.push({ path, reason: "expected a source connection record" }); return null; }
    const id = opaque(value.id, `${path}.id`, issues);
    const fromRowId = opaque(value.from_map_solarsystem_id, `${path}.from_map_solarsystem_id`, issues);
    const toRowId = opaque(value.to_map_solarsystem_id, `${path}.to_map_solarsystem_id`, issues);
    if (!id || !fromRowId || !toRowId) return null;
    if (allowNew) {
      if (rootConnectionIds.has(id)) issues.push({ path: `${path}.id`, reason: "duplicate map connection identity" });
      rootConnectionIds.add(id);
    }
    if (!sourceSystemIds.has(fromRowId) || !sourceSystemIds.has(toRowId) || fromRowId === toRowId)
      issues.push({ path, reason: "map connection endpoints are missing or outside selected map scope" });
    const current = connectionById.get(id);
    if (current && (current.fromRowId !== fromRowId || current.toRowId !== toRowId))
      issues.push({ path, reason: "map connection identity has contradictory endpoints" });
    if (current) {
      current.relationshipResources.push({ value, path });
      return current;
    }
    if (!allowNew) {
      issues.push({ path: `${path}.id`, reason: "selected system references a map connection absent from map detail" });
      return null;
    }
    const connection = { id, fromRowId, toRowId, value, path, relationshipResources: [{ value, path }] };
    connectionById.set(id, connection);
    return connection;
  };
  mapConnectionRows.forEach((value, index) => addConnection(value, `$.data.map_connections[${index}]`, true));

  const systems: WormholeSystemsFixture["systems"] = [];
  const sourceDetails: unknown[] = [];
  const signatures: WormholeSystemsFixture["signatures"] = [];
  const signatureByDirection = new Map<string, string>();
  const signatureBySourceId = new Map<string, { key: string; mapSystemId: string; signatureCode: string; sourceConnectionId: string | null }>();
  const signatureRowByKey = new Map<string, string>();
  const auditRecordCountByDetail: number[] = [];
  for (let index = 0; index < input.systemDetails.length; index++) {
    const raw = input.systemDetails[index];
    const mapSystem = mapSystems[index];
    const path = `$.systemDetails[${index}]`;
    if (!record(raw) || !record(raw.data)) { issues.push({ path: `${path}.data`, reason: "expected selected map-solar-system detail envelope" }); continue; }
    const body = raw.data;
    if (!record(mapSystem)) continue;
    const mapSystemId = opaque(mapSystem.id, `${path}.mapSystemId`, issues);
    const mapId = opaque(body.map_id, `${path}.data.map_id`, issues);
    const detailId = opaque(body.id, `${path}.data.id`, issues);
    const detailEveId = eveId(body.solarsystem_id, `${path}.data.solarsystem_id`, issues);
    const expectedEveId = eveId(mapSystem.solarsystem_id, `${path}.mapSystem.solarsystem_id`, issues);
    if (detailId !== mapSystemId || mapId !== input.mapId || detailEveId !== expectedEveId)
      issues.push({ path: `${path}.data`, reason: "selected map-solar-system detail identity or scope mismatch" });
    for (const [collection, max] of [["signatures", 2_000], ["map_connections", 2_000], ["audits", 10_000]] as const)
      if (!Array.isArray(body[collection]) || body[collection]!.length > max)
        issues.push({ path: `${path}.data.${collection}`, reason: "expected a bounded source array" });
    if (!isJson(raw)) issues.push({ path, reason: "source detail is not bounded JSON data" });
    sourceDetails.push(raw);
    if (detailEveId === null || mapSystemId === null) continue;
    const systemObservedAt = observedTime(body.observed_at, `${path}.data.observed_at`, issues);
    systems.push({ eveSolarSystemId: detailEveId, sourceSystemId: mapSystemId, status: "known", observedAt: systemObservedAt });

    const rowConnections = new Set<string>();
    if (Array.isArray(body.map_connections)) body.map_connections.forEach((value, connectionIndex) => {
      const connectionPath = `${path}.data.map_connections[${connectionIndex}]`;
      const connection = addConnection(value, connectionPath);
      if (!connection) return;
      if (connection.fromRowId !== mapSystemId && connection.toRowId !== mapSystemId)
        issues.push({ path: connectionPath, reason: "map connection is not related to selected system" });
      if (rowConnections.has(connection.id)) issues.push({ path: connectionPath, reason: "duplicate map connection relationship" });
      rowConnections.add(connection.id);
    });
    if (Array.isArray(body.audits)) body.audits.forEach((audit, auditIndex) => {
      const auditPath = `${path}.data.audits[${auditIndex}]`;
      if (!record(audit)) issues.push({ path: auditPath, reason: "expected a source audit record" });
      else opaque(audit.id, `${auditPath}.id`, issues);
    });
    auditRecordCountByDetail.push(Array.isArray(body.audits) ? body.audits.length : 0);

    if (!Array.isArray(body.signatures)) continue;
    body.signatures.forEach((value, signatureIndex) => {
      const signaturePath = `${path}.data.signatures[${signatureIndex}]`;
      if (!record(value)) { issues.push({ path: signaturePath, reason: "expected signature source record" }); return; }
      const sourceId = opaque(value.id, `${signaturePath}.id`, issues);
      const signatureCode = typeof value.signature_id === "string" && value.signature_id.trim() === value.signature_id &&
        value.signature_id.length > 0 && value.signature_id.length <= 64 ? value.signature_id : null;
      if (!signatureCode) issues.push({ path: `${signaturePath}.signature_id`, reason: "expected exact source signature identity" });
      const signatureRowId = opaque(value.map_solarsystem_id, `${signaturePath}.map_solarsystem_id`, issues);
      if (signatureRowId !== mapSystemId) issues.push({ path: `${signaturePath}.map_solarsystem_id`, reason: "signature is outside its selected system" });
      const connectionId = nullableOpaque(value.map_connection_id, `${signaturePath}.map_connection_id`, issues);
      const wormholeId = nullableOpaque(value.wormhole_id, `${signaturePath}.wormhole_id`, issues);
      const signatureObservedAt = observedTime(value.observed_at, `${signaturePath}.observed_at`, issues);
      if (connectionId && !connectionById.has(connectionId))
        issues.push({ path: `${signaturePath}.map_connection_id`, reason: "signature references an unknown map connection" });
      if (value.map_connection !== undefined && value.map_connection !== null) {
        if (value.map_connection_id === null)
          issues.push({ path: `${signaturePath}.map_connection`, reason: "nested connection conflicts with a null map_connection_id" });
        if (!record(value.map_connection)) issues.push({ path: `${signaturePath}.map_connection`, reason: "expected nullable connection relationship" });
        else {
          const nestedId = opaque(value.map_connection.id, `${signaturePath}.map_connection.id`, issues);
          if (!nestedId || !connectionById.has(nestedId) || (connectionId && connectionId !== nestedId))
            issues.push({ path: `${signaturePath}.map_connection`, reason: "nested connection relationship is missing or contradictory" });
        }
      }
      if (value.wormhole !== undefined && value.wormhole !== null && !record(value.wormhole))
        issues.push({ path: `${signaturePath}.wormhole`, reason: "expected nullable wormhole relationship" });
      if (record(value.wormhole)) {
        if (value.wormhole_id === null)
          issues.push({ path: `${signaturePath}.wormhole`, reason: "nested wormhole conflicts with a null wormhole_id" });
        const nestedWormholeId = opaque(value.wormhole.id, `${signaturePath}.wormhole.id`, issues);
        if (wormholeId !== null && nestedWormholeId !== wormholeId)
          issues.push({ path: `${signaturePath}.wormhole`, reason: "nested wormhole identity mismatch" });
      }
      if (!sourceId || !signatureCode || !mapSystemId) return;
      if (signatures.some(signature => signature.sourceSignatureId === sourceId)) issues.push({ path: `${signaturePath}.id`, reason: "duplicate source signature identity" });
      const key = `source-signature:${mapSystemId}:${sourceId}`;
      const directionKey = `${mapSystemId}\0${signatureCode}`;
      if (signatureByDirection.has(directionKey)) issues.push({ path: signaturePath, reason: "duplicate directional source signature identity" });
      signatureByDirection.set(directionKey, key);
      signatureBySourceId.set(sourceId, { key, mapSystemId, signatureCode, sourceConnectionId: connectionId });
      signatureRowByKey.set(key, mapSystemId);
      signatures.push({ signatureKey: key, scannerEveSystemId: detailEveId, signatureCode,
        sourceSignatureId: sourceId, sourceConnectionId: connectionId, connectedEveSystemId: null,
        status: "unknown", size: null, observedAt: signatureObservedAt, freshUntil: null });
    });
  }

  for (const signature of signatures) {
    if (!signature.sourceConnectionId) continue;
    const sourceConnection = connectionById.get(signature.sourceConnectionId);
    const scannerRowId = signatureRowByKey.get(signature.signatureKey);
    if (!sourceConnection || !scannerRowId) continue;
    const destinationRowId = scannerRowId === sourceConnection.fromRowId ? sourceConnection.toRowId
      : scannerRowId === sourceConnection.toRowId ? sourceConnection.fromRowId : null;
    const destinationEveId = destinationRowId ? sourceSystemIds.get(destinationRowId) : undefined;
    if (destinationEveId === undefined) {
      issues.push({ path: "$.systemDetails", reason: "signature connection does not include its scanner system as an endpoint" });
      continue;
    }
    signature.connectedEveSystemId = destinationEveId;
  }

  const connectionDirectionKeys = new Map<string, [string | null, string | null]>();
  const connectionObservedAtById = new Map<string, string | null>();
  const signatureConnectionByResourceId = new Map<string, string>();
  for (const connection of connectionById.values()) {
    const fromEveSystemId = sourceSystemIds.get(connection.fromRowId);
    const toEveSystemId = sourceSystemIds.get(connection.toRowId);
    if (fromEveSystemId === undefined || toEveSystemId === undefined || fromEveSystemId === toEveSystemId) continue;
    let connectionObservedAt: string | null = null;
    let observedAtMs: number | null = null;
    for (const relationship of connection.relationshipResources) {
      const resourceObservedAt = observedTime(relationship.value.observed_at, `${relationship.path}.observed_at`, issues);
      if (resourceObservedAt !== null) {
        const resourceObservedAtMs = Date.parse(resourceObservedAt);
        if (observedAtMs !== null && observedAtMs !== resourceObservedAtMs)
          issues.push({ path: `${relationship.path}.observed_at`, reason: "map connection relationship has contradictory observation timestamps" });
        else {
          observedAtMs = resourceObservedAtMs;
          connectionObservedAt = resourceObservedAt;
        }
      }
      const connectionSignatures = relationship.value.signatures;
      if (connectionSignatures === undefined || connectionSignatures === null) continue;
      if (!Array.isArray(connectionSignatures) || connectionSignatures.length > 2_000) {
        issues.push({ path: `${relationship.path}.signatures`, reason: "expected a bounded connection-signature array" });
        continue;
      }
      const seenSignatureIds = new Set<string>();
      const seenDirections = new Set<string>();
      connectionSignatures.forEach((value, index) => {
        const path = `${relationship.path}.signatures[${index}]`;
        if (!record(value)) { issues.push({ path, reason: "expected a connection-signature source record" }); return; }
        const sourceId = opaque(value.id, `${path}.id`, issues);
        const owningConnectionId = sourceId ? signatureConnectionByResourceId.get(sourceId) : undefined;
        if (sourceId && owningConnectionId && owningConnectionId !== connection.id)
          issues.push({ path: `${path}.id`, reason: "connection signature resource is reused under a different map connection" });
        else if (sourceId) signatureConnectionByResourceId.set(sourceId, connection.id);
        if (sourceId && seenSignatureIds.has(sourceId)) issues.push({ path: `${path}.id`, reason: "duplicate connection signature resource reference" });
        if (sourceId) seenSignatureIds.add(sourceId);
        const code = typeof value.signature_id === "string" && value.signature_id.trim() === value.signature_id && value.signature_id.length > 0 && value.signature_id.length <= 64 ? value.signature_id : null;
        if (!code) issues.push({ path: `${path}.signature_id`, reason: "expected exact source signature identity" });
        const rowId = opaque(value.map_solarsystem_id, `${path}.map_solarsystem_id`, issues);
        if (rowId !== connection.fromRowId && rowId !== connection.toRowId)
          issues.push({ path: `${path}.map_solarsystem_id`, reason: "connection signature is outside connection endpoints" });
        if (value.map_connection_id !== undefined && value.map_connection_id !== null && opaque(value.map_connection_id, `${path}.map_connection_id`, issues) !== connection.id)
          issues.push({ path: `${path}.map_connection_id`, reason: "connection signature references a different connection" });
        const fullSignature = sourceId ? signatureBySourceId.get(sourceId) : undefined;
        if (sourceId && !fullSignature)
          issues.push({ path: `${path}.id`, reason: "connection signature does not reference a selected-system signature resource" });
        if (fullSignature && (fullSignature.mapSystemId !== rowId || fullSignature.signatureCode !== code))
          issues.push({ path, reason: "connection signature reference contradicts its full signature resource" });
        if (code && rowId && (rowId === connection.fromRowId || rowId === connection.toRowId)) {
          const direction = `${rowId}\0${code}`;
          if (seenDirections.has(direction)) issues.push({ path, reason: "duplicate connection signature relationship" });
          seenDirections.add(direction);
          if (!signatureByDirection.has(direction)) issues.push({ path, reason: "connection signature does not reference a selected-system signature" });
          if (fullSignature?.sourceConnectionId && fullSignature.sourceConnectionId !== connection.id)
            issues.push({ path, reason: "connection signature contradicts selected signature connection identity" });
        }
        if (value.wormhole !== undefined && value.wormhole !== null && !record(value.wormhole))
          issues.push({ path: `${path}.wormhole`, reason: "expected nullable wormhole relationship" });
        if (record(value.wormhole)) opaque(value.wormhole.id, `${path}.wormhole.id`, issues);
      });
    }
    connectionObservedAtById.set(connection.id, connectionObservedAt);
    const endpointKeys: [string | null, string | null] = [null, null];
    for (const [index, rowId] of [connection.fromRowId, connection.toRowId].entries()) {
      // A signature's direct map_connection_id is a confirmed directional reference too.
      const directional = signatures.filter(signature => signature.sourceConnectionId === connection.id &&
        signature.scannerEveSystemId === sourceSystemIds.get(rowId));
      if (directional.length > 1) issues.push({ path: connection.path, reason: "connection has multiple selected signatures for one endpoint" });
      if (!endpointKeys[index] && directional.length === 1) endpointKeys[index] = directional[0].signatureKey;
    }
    connectionDirectionKeys.set(connection.id, endpointKeys);
  }

  const connections: WormholeSystemsFixture["connections"] = [];
  for (const connection of connectionById.values()) {
    const fromEveSystemId = sourceSystemIds.get(connection.fromRowId);
    const toEveSystemId = sourceSystemIds.get(connection.toRowId);
    if (fromEveSystemId === undefined || toEveSystemId === undefined || fromEveSystemId === toEveSystemId) continue;
    const connectionObservedAt = connectionObservedAtById.get(connection.id) ?? null;
    const [relatedFrom, relatedTo] = connectionDirectionKeys.get(connection.id) ?? [null, null];
    const from = signatures.filter(signature => signature.sourceConnectionId === connection.id && signature.scannerEveSystemId === fromEveSystemId);
    const to = signatures.filter(signature => signature.sourceConnectionId === connection.id && signature.scannerEveSystemId === toEveSystemId);
    connections.push({ sourceConnectionId: connection.id, fromEveSystemId, toEveSystemId, state: "unknown",
      observedAt: connectionObservedAt, freshUntil: null, fromSignatureKey: relatedFrom ?? (from.length === 1 ? from[0].signatureKey : null),
      toSignatureKey: relatedTo ?? (to.length === 1 ? to[0].signatureKey : null) });
  }

  if (issues.length) return { ok: false, issues: issues.slice(0, 40) };
  const canonical = normalizeWormholeSystemsFixture({ fixtureOnly: true, sourceKind: "wormholesystems", schemaVersion: 1,
    sourceIdentity: input.sourceIdentity, revisionOrDigest: input.revisionOrDigest, fetchedAt: input.fetchedAt,
    observedAt, scope: { canonicalMapId: input.canonicalMapId, eveSolarSystemIds: systems.map(system => system.eveSolarSystemId) },
    systems, signatures, connections, authorityMetadata: { confirmed: false, fields: null },
    sourceMetadata: { map: detail, mapSolarSystems: mapSystems, solarSystemDetails: sourceDetails } });
  if (!canonical.ok) return { ok: false, issues: canonical.issues.slice(0, 40).map(issue => ({ path: issue.path, reason: issue.reason })) };
  return { ok: true, fixture: canonical.value, diagnostics: { systemCount: systems.length, signatureCount: signatures.length,
    connectionCount: connections.length, unknownStatusCount: signatures.length + connections.length, skippedConnectionCount: 0,
    opaqueMapConnectionCount: mapConnectionRows.length, unmappedMapConnectionCount: 0,
    auditRecordCount: auditRecordCountByDetail.reduce((total, count) => total + count, 0),
    sourceMapFieldNames: Object.keys(detail).sort() } };
}

/** Ensure upstream JSON values do not contain the credential before any snapshot is persisted. */
export function containsSecretValue(value: unknown, secret: string, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some(item => containsSecretValue(item, secret, depth + 1));
  if (record(value)) return Object.values(value).some(item => containsSecretValue(item, secret, depth + 1));
  return false;
}
