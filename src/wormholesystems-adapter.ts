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
  const parsed = typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1 || (parsed as number) > 2_147_483_647) {
    issues.push({ path, reason: "expected an explicit EVE solar-system ID" });
    return null;
  }
  return parsed as number;
};
const nullableOpaque = (value: unknown, path: string, issues: AdapterIssue[]): string | null => value == null ? null : opaque(value, path, issues);
const sourceTime = (value: unknown, path: string, issues: AdapterIssue[]): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    issues.push({ path, reason: "expected a valid source timestamp or null" });
    return null;
  }
  return value;
};
const status = (value: unknown, values: readonly string[]): string => typeof value === "string" && values.includes(value.toLowerCase()) ? value.toLowerCase() : "unknown";
const isJson = (value: unknown, depth = 0): boolean => {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 20_000 && value.every(item => isJson(item, depth + 1));
  return record(value) && Object.keys(value).length <= 2_000 && Object.values(value).every(item => isJson(item, depth + 1));
};

/** Validate the public map-resource envelope without interpreting unknown settings. */
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
  if (Array.isArray(body.map_solarsystems)) body.map_solarsystems.forEach((row, index) => {
    if (!record(row)) { issues.push({ path: `$.data.map_solarsystems[${index}]`, reason: "expected a source record" }); return; }
    opaque(row.id, `$.data.map_solarsystems[${index}].id`, issues);
    eveId(row.solar_system_id, `$.data.map_solarsystems[${index}].solar_system_id`, issues);
  });
  if (Array.isArray(body.map_connections)) body.map_connections.forEach((row, index) => {
    if (!record(row)) { issues.push({ path: `$.data.map_connections[${index}]`, reason: "expected a source record" }); return; }
    opaque(row.id, `$.data.map_connections[${index}].id`, issues);
  });
  if (!isJson(body)) issues.push({ path: "$.data", reason: "source map detail is not bounded JSON data" });
  return issues.length ? { issues } : { detail: body as SourceMapDetail, issues };
}

/** Normalize only the explicit candidate v1 resource fields; retain all raw JSON as opaque source metadata. */
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
  const observedAt = sourceTime(detail.observed_at, "$.data.observed_at", issues);
  const mapSystems = detail.map_solarsystems as unknown[];
  if (input.systemDetails.length !== mapSystems.length || input.systemDetails.length > 100)
    issues.push({ path: "$.systemDetails", reason: "map-system detail count does not match map scope" });

  const systems: WormholeSystemsFixture["systems"] = [];
  const sourceSystemIds = new Map<string, number>();
  const sourceDetails: unknown[] = [];
  const signatures: WormholeSystemsFixture["signatures"] = [];
  const signatureBySourceId = new Map<string, string>();
  const pendingConnections = new Map<string, Array<{ key: string; systemId: number; connectedId: number }>>();
  const explicitConnections: WormholeSystemsFixture["connections"] = [];
  const explicitConnectionIds = new Set<string>();
  let unknownStatusCount = 0;
  let skippedConnectionCount = 0;
  let unmappedMapConnectionCount = 0;

  mapSystems.forEach((candidate, index) => {
    if (!record(candidate)) return;
    const mapSystemId = opaque(candidate.id, `$.data.map_solarsystems[${index}].id`, issues);
    const eveSystemId = eveId(candidate.solar_system_id, `$.data.map_solarsystems[${index}].solar_system_id`, issues);
    if (!mapSystemId || eveSystemId === null) return;
    if (sourceSystemIds.has(mapSystemId)) issues.push({ path: `$.data.map_solarsystems[${index}].id`, reason: "duplicate map solar-system identity" });
    sourceSystemIds.set(mapSystemId, eveSystemId);
  });

  for (let index = 0; index < input.systemDetails.length; index++) {
    const raw = input.systemDetails[index];
    const mapSystem = mapSystems[index];
    const path = `$.systemDetails[${index}]`;
    if (!record(raw) || !record(raw.data)) { issues.push({ path: `${path}.data`, reason: "expected selected map-solar-system detail envelope" }); continue; }
    const body = raw.data;
    if (!record(mapSystem)) continue;
    const mapSystemId = opaque(mapSystem.id, `${path}.mapSystemId`, issues);
    const eveSystemId = eveId(mapSystem.solar_system_id, `${path}.mapSystemEveId`, issues);
    const detailId = opaque(body.id, `${path}.data.id`, issues);
    const detailEveId = eveId(body.solar_system_id, `${path}.data.solar_system_id`, issues);
    if (detailId !== mapSystemId || detailEveId !== eveSystemId)
      issues.push({ path: `${path}.data`, reason: "selected map-solar-system detail identity mismatch" });
    for (const collection of ["signatures", "connections", "audit"] as const)
      if (!Array.isArray(body[collection]) || body[collection]!.length > (collection === "audit" ? 10_000 : 2_000))
        issues.push({ path: `${path}.data.${collection}`, reason: "expected a bounded source array" });
    if (Array.isArray(body.connections)) body.connections.forEach((connection, connectionIndex) => {
      if (!record(connection)) { issues.push({ path: `${path}.data.connections[${connectionIndex}]`, reason: "expected a source connection record" }); return; }
      opaque(connection.id, `${path}.data.connections[${connectionIndex}].id`, issues);
    });
    if (Array.isArray(body.audit)) body.audit.forEach((audit, auditIndex) => {
      if (!record(audit)) issues.push({ path: `${path}.data.audit[${auditIndex}]`, reason: "expected a source audit record" });
    });
    if (!isJson(raw)) issues.push({ path, reason: "source detail is not bounded JSON data" });
    sourceDetails.push(raw);
    if (eveSystemId === null) continue;
    const observedAt = sourceTime(body.observed_at, `${path}.data.observed_at`, issues);
    systems.push({ eveSolarSystemId: eveSystemId, sourceSystemId: mapSystemId, status: "known", observedAt });

    if (!Array.isArray(body.signatures)) continue;
    body.signatures.forEach((value, signatureIndex) => {
      const signaturePath = `${path}.data.signatures[${signatureIndex}]`;
      if (!record(value)) { issues.push({ path: signaturePath, reason: "expected signature source record" }); return; }
      const sourceId = opaque(value.id, `${signaturePath}.id`, issues);
      if (typeof value.signature_code !== "string" || !value.signature_code.trim() || value.signature_code.length > 64 || value.signature_code.trim() !== value.signature_code)
        issues.push({ path: `${signaturePath}.signature_code`, reason: "expected exact source signature code" });
      if (!sourceId || typeof value.signature_code !== "string" || !value.signature_code.trim() || value.signature_code.length > 64) return;
      const key = `source-signature:${mapSystemId}:${sourceId}`;
      if (signatureBySourceId.has(`${mapSystemId}\0${sourceId}`)) issues.push({ path: `${signaturePath}.id`, reason: "duplicate source signature identity" });
      signatureBySourceId.set(`${mapSystemId}\0${sourceId}`, key);
      const connectedId = value.connected_solar_system_id == null ? null : eveId(value.connected_solar_system_id, `${signaturePath}.connected_solar_system_id`, issues);
      const sourceConnectionId = nullableOpaque(value.connection_id, `${signaturePath}.connection_id`, issues);
      const statusValue = status(value.status, ["active", "inactive"]);
      if (statusValue === "unknown") unknownStatusCount++;
      const observed = sourceTime(value.observed_at, `${signaturePath}.observed_at`, issues);
      const freshUntil = sourceTime(value.fresh_until, `${signaturePath}.fresh_until`, issues);
      const size = value.size == null ? null : typeof value.size === "string" && value.size.length <= 64 ? value.size : null;
      if (value.size != null && size === null) issues.push({ path: `${signaturePath}.size`, reason: "expected nullable bounded size" });
      signatures.push({ signatureKey: key, scannerEveSystemId: eveSystemId, signatureCode: value.signature_code,
        sourceSignatureId: sourceId, sourceConnectionId, connectedEveSystemId: connectedId,
        status: statusValue as "active" | "inactive" | "unknown", size, observedAt: observed, freshUntil });
      if (sourceConnectionId && connectedId !== null) {
        const directions = pendingConnections.get(sourceConnectionId) ?? [];
        directions.push({ key, systemId: eveSystemId, connectedId });
        pendingConnections.set(sourceConnectionId, directions);
      } else if (sourceConnectionId || connectedId !== null) skippedConnectionCount++;
    });
  }

  for (const [index, value] of (detail.map_connections as unknown[]).entries()) {
    if (!record(value) || !("source_map_solarsystem_id" in value || "target_map_solarsystem_id" in value)) {
      unmappedMapConnectionCount++;
      continue;
    }
    const path = `$.data.map_connections[${index}]`;
    const id = opaque(value.id, `${path}.id`, issues);
    const sourceSystemId = opaque(value.source_map_solarsystem_id, `${path}.source_map_solarsystem_id`, issues);
    const targetSystemId = opaque(value.target_map_solarsystem_id, `${path}.target_map_solarsystem_id`, issues);
    const fromEveSystemId = sourceSystemId ? sourceSystemIds.get(sourceSystemId) : undefined;
    const toEveSystemId = targetSystemId ? sourceSystemIds.get(targetSystemId) : undefined;
    if (fromEveSystemId === undefined || toEveSystemId === undefined || fromEveSystemId === toEveSystemId)
      issues.push({ path, reason: "map connection endpoints are missing, ambiguous or outside map scope" });
    const sourceSignatureId = nullableOpaque(value.source_signature_id, `${path}.source_signature_id`, issues);
    const targetSignatureId = nullableOpaque(value.target_signature_id, `${path}.target_signature_id`, issues);
    const fromSignatureKey = sourceSignatureId && sourceSystemId ? signatureBySourceId.get(`${sourceSystemId}\0${sourceSignatureId}`) ?? null : null;
    const toSignatureKey = targetSignatureId && targetSystemId ? signatureBySourceId.get(`${targetSystemId}\0${targetSignatureId}`) ?? null : null;
    if ((sourceSignatureId && !fromSignatureKey) || (targetSignatureId && !toSignatureKey))
      issues.push({ path, reason: "map connection references an unknown directional signature" });
    const rawStatus = status(value.status, ["active", "broken", "expired"]);
    if (rawStatus === "unknown") unknownStatusCount++;
    const observedAt = sourceTime(value.observed_at, `${path}.observed_at`, issues);
    const freshUntil = sourceTime(value.fresh_until, `${path}.fresh_until`, issues);
    if (id && fromEveSystemId !== undefined && toEveSystemId !== undefined) {
      if (explicitConnectionIds.has(id)) issues.push({ path: `${path}.id`, reason: "duplicate source connection identity" });
      explicitConnectionIds.add(id);
      explicitConnections.push({ sourceConnectionId: id, fromEveSystemId, toEveSystemId,
        state: rawStatus as "active" | "broken" | "expired" | "unknown", observedAt, freshUntil,
        fromSignatureKey, toSignatureKey });
    }
  }

  const connections: WormholeSystemsFixture["connections"] = [...explicitConnections];
  const knownEveSystems = new Set(sourceSystemIds.values());
  for (const [sourceConnectionId, directions] of pendingConnections) {
    if (explicitConnectionIds.has(sourceConnectionId)) continue;
    const endpoints = new Set(directions.flatMap(direction => [direction.systemId, direction.connectedId]));
    if (endpoints.size !== 2 || directions.length > 2 || [...endpoints].some(id => !knownEveSystems.has(id))) {
      issues.push({ path: "$.data.map_connections", reason: "source connection has contradictory or unsupported endpoints" });
      continue;
    }
    const [fromEveSystemId, toEveSystemId] = [...endpoints].sort((a, b) => a - b);
    const from = directions.find(direction => direction.systemId === fromEveSystemId && direction.connectedId === toEveSystemId);
    const to = directions.find(direction => direction.systemId === toEveSystemId && direction.connectedId === fromEveSystemId);
    const connectionTimes = signatures.filter(signature => signature.sourceConnectionId === sourceConnectionId).map(signature => signature.observedAt).filter(Boolean) as string[];
    const freshnessTimes = signatures.filter(signature => signature.sourceConnectionId === sourceConnectionId).map(signature => signature.freshUntil).filter(Boolean) as string[];
    unknownStatusCount++;
    connections.push({ sourceConnectionId, fromEveSystemId, toEveSystemId, state: "unknown",
      observedAt: connectionTimes.length ? connectionTimes.sort().at(-1)! : null,
      freshUntil: freshnessTimes.length ? freshnessTimes.sort()[0] : null, fromSignatureKey: from?.key ?? null, toSignatureKey: to?.key ?? null });
  }

  if (issues.length) return { ok: false, issues: issues.slice(0, 40) };
  const canonical = normalizeWormholeSystemsFixture({ fixtureOnly: true, sourceKind: "wormholesystems", schemaVersion: 1,
    sourceIdentity: input.sourceIdentity, revisionOrDigest: input.revisionOrDigest, fetchedAt: input.fetchedAt,
    observedAt,
    scope: { canonicalMapId: input.canonicalMapId, eveSolarSystemIds: systems.map(system => system.eveSolarSystemId) },
    systems, signatures, connections, authorityMetadata: { confirmed: false, fields: null },
    sourceMetadata: { map: detail, mapSolarSystems: mapSystems, solarSystemDetails: sourceDetails } });
  if (!canonical.ok) return { ok: false, issues: canonical.issues.slice(0, 40).map(issue => ({ path: issue.path, reason: issue.reason })) };
  return { ok: true, fixture: canonical.value, diagnostics: { systemCount: systems.length, signatureCount: signatures.length,
    connectionCount: connections.length, unknownStatusCount, skippedConnectionCount,
    opaqueMapConnectionCount: (detail.map_connections as unknown[]).length,
    unmappedMapConnectionCount,
    auditRecordCount: sourceDetails.reduce<number>((count, entry: any) => count + (Array.isArray(entry?.data?.audit) ? entry.data.audit.length : 0), 0),
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
