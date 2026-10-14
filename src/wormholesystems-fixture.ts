/**
 * Versioned canonical snapshot boundary for synthetic fixtures and the
 * strictly validated WormholeSystems source adapter. Nothing here performs I/O.
 */
export type ConnectionState = "active" | "broken" | "expired" | "unknown";
export type FixtureSignatureStatus = "active" | "inactive" | "unknown";

export type WormholeSystemsFixture = {
  fixtureOnly: true;
  sourceKind?: "synthetic" | "wormholesystems";
  schemaVersion: 1;
  sourceIdentity: string;
  revisionOrDigest: string;
  fetchedAt: string;
  observedAt: string | null;
  scope: { canonicalMapId: string; eveSolarSystemIds: number[] };
  systems: Array<{
    eveSolarSystemId: number;
    sourceSystemId: string | null;
    status: "known" | "unknown";
    observedAt: string | null;
  }>;
  signatures: Array<{
    signatureKey: string;
    scannerEveSystemId: number;
    signatureCode: string;
    sourceSignatureId: string | null;
    sourceConnectionId: string | null;
    connectedEveSystemId: number | null;
    status: FixtureSignatureStatus;
    size: string | null;
    observedAt: string | null;
    freshUntil: string | null;
  }>;
  connections: Array<{
    sourceConnectionId: string;
    fromEveSystemId: number;
    toEveSystemId: number;
    state: ConnectionState;
    observedAt: string | null;
    freshUntil: string | null;
    fromSignatureKey: string | null;
    toSignatureKey: string | null;
  }>;
  authorityMetadata: { confirmed: false; fields: null };
  /** Raw validated source fields are retained as opaque JSON, never interpreted as authority. */
  sourceMetadata?: unknown;
};

export type NexumPreviewFixture = {
  fixtureOnly: true;
  canonicalMapId: string;
  fetchedAt: string;
  systems: Array<{
    nexumSystemId: string;
    eveSolarSystemId: number;
    status: "active" | "unknown";
  }>;
  connections: Array<{
    nexumConnectionId: string;
    sourceSystemId: string;
    targetSystemId: string;
    status: ConnectionState;
    sourceSignatureRowId: string | null;
    targetSignatureRowId: string | null;
    observedAt: string | null;
  }>;
  signatures: Array<{
    nexumSignatureRowId: string;
    nexumSystemId: string;
    signatureCode: string;
    status: FixtureSignatureStatus;
    size: string | null;
    notes: string | null;
    fetchedAt: string | null;
  }>;
};

export type FixtureValidationIssue = { path: string; reason: string };
export type FixtureValidationResult =
  | { ok: true; value: WormholeSystemsFixture }
  | { ok: false; issues: FixtureValidationIssue[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strictKeys = (value: Record<string, unknown>, keys: string[], path: string, issues: FixtureValidationIssue[]) => {
  for (const key of keys) if (!(key in value)) issues.push({ path: `${path}.${key}`, reason: "required field is missing" });
  for (const key of Object.keys(value)) if (!keys.includes(key)) issues.push({ path: `${path}.${key}`, reason: "unrecognized field" });
};
const nonempty = (value: unknown, path: string, issues: FixtureValidationIssue[], max = 256): value is string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.trim() !== value) {
    issues.push({ path, reason: "expected a trimmed non-empty string" });
    return false;
  }
  return true;
};
const nullableString = (value: unknown, path: string, issues: FixtureValidationIssue[], max = 256): value is string | null =>
  value === null || nonempty(value, path, issues, max);
const timestamp = (value: unknown, path: string, issues: FixtureValidationIssue[], nullable = false): value is string | null => {
  if (nullable && value === null) return true;
  const match = typeof value === "string"
    ? /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value)
    : null;
  if (!match || !Number.isFinite(Date.parse(value as string))) {
    issues.push({ path, reason: "expected an ISO-8601 timestamp" });
    return false;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
      (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) {
    issues.push({ path, reason: "expected a valid ISO-8601 calendar timestamp" });
    return false;
  }
  return true;
};
const eveId = (value: unknown, path: string, issues: FixtureValidationIssue[]): value is number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    issues.push({ path, reason: "expected a positive EVE solar-system ID" });
    return false;
  }
  return true;
};
const enumValue = <T extends string>(value: unknown, values: readonly T[], path: string, issues: FixtureValidationIssue[]): value is T => {
  if (typeof value !== "string" || !values.includes(value as T)) {
    issues.push({ path, reason: "unrecognized required value" });
    return false;
  }
  return true;
};
const identity = (scanner: number, code: string, sourceId: string | null) => `${scanner}\0${code}\0${sourceId ?? ""}`;

/** Strict validator for the local, explicitly synthetic v1 fixture contract. */
export function validateWormholeSystemsFixture(input: unknown): FixtureValidationResult {
  const issues: FixtureValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", reason: "expected an object" }] };
  const fixtureKeys = ["fixtureOnly", "sourceKind", "schemaVersion", "sourceIdentity", "revisionOrDigest", "fetchedAt", "observedAt", "scope", "systems", "signatures", "connections", "authorityMetadata", "sourceMetadata"];
  for (const key of ["fixtureOnly", "schemaVersion", "sourceIdentity", "revisionOrDigest", "fetchedAt", "observedAt", "scope", "systems", "signatures", "connections", "authorityMetadata"])
    if (!(key in input)) issues.push({ path: `$.${key}`, reason: "required field is missing" });
  for (const key of Object.keys(input)) if (!fixtureKeys.includes(key)) issues.push({ path: `$.${key}`, reason: "unrecognized field" });
  if (input.fixtureOnly !== true) issues.push({ path: "$.fixtureOnly", reason: "must be true for an offline fixture" });
  if (input.sourceKind !== undefined && input.sourceKind !== "synthetic" && input.sourceKind !== "wormholesystems")
    issues.push({ path: "$.sourceKind", reason: "unsupported source kind" });
  if (input.sourceKind === "wormholesystems" && nonempty(input.sourceIdentity, "$.sourceIdentity", issues) && !input.sourceIdentity.startsWith("wormholesystems:"))
    issues.push({ path: "$.sourceIdentity", reason: "source snapshot identity must be labeled wormholesystems:" });
  if (input.schemaVersion !== 1) issues.push({ path: "$.schemaVersion", reason: "unsupported fixture schema version" });
  if (input.sourceKind !== "wormholesystems" && nonempty(input.sourceIdentity, "$.sourceIdentity", issues) && !input.sourceIdentity.startsWith("synthetic:"))
    issues.push({ path: "$.sourceIdentity", reason: "offline fixture identity must be labeled synthetic:" });
  nonempty(input.revisionOrDigest, "$.revisionOrDigest", issues);
  timestamp(input.fetchedAt, "$.fetchedAt", issues);
  timestamp(input.observedAt, "$.observedAt", issues, true);

  if (!isRecord(input.scope)) issues.push({ path: "$.scope", reason: "expected an object" });
  else {
    strictKeys(input.scope, ["canonicalMapId", "eveSolarSystemIds"], "$.scope", issues);
    nonempty(input.scope.canonicalMapId, "$.scope.canonicalMapId", issues);
    if (!Array.isArray(input.scope.eveSolarSystemIds)) issues.push({ path: "$.scope.eveSolarSystemIds", reason: "expected an array" });
    else input.scope.eveSolarSystemIds.forEach((id, i) => eveId(id, `$.scope.eveSolarSystemIds[${i}]`, issues));
  }

  if (!Array.isArray(input.systems)) issues.push({ path: "$.systems", reason: "expected an array" });
  else input.systems.forEach((row, i) => {
    const p = `$.systems[${i}]`;
    if (!isRecord(row)) { issues.push({ path: p, reason: "expected an object" }); return; }
    strictKeys(row, ["eveSolarSystemId", "sourceSystemId", "status", "observedAt"], p, issues);
    eveId(row.eveSolarSystemId, `${p}.eveSolarSystemId`, issues);
    nullableString(row.sourceSystemId, `${p}.sourceSystemId`, issues);
    enumValue(row.status, ["known", "unknown"] as const, `${p}.status`, issues);
    timestamp(row.observedAt, `${p}.observedAt`, issues, true);
  });

  if (!Array.isArray(input.signatures)) issues.push({ path: "$.signatures", reason: "expected an array" });
  else input.signatures.forEach((row, i) => {
    const p = `$.signatures[${i}]`;
    if (!isRecord(row)) { issues.push({ path: p, reason: "expected an object" }); return; }
    strictKeys(row, ["signatureKey", "scannerEveSystemId", "signatureCode", "sourceSignatureId", "sourceConnectionId", "connectedEveSystemId", "status", "size", "observedAt", "freshUntil"], p, issues);
    nonempty(row.signatureKey, `${p}.signatureKey`, issues);
    eveId(row.scannerEveSystemId, `${p}.scannerEveSystemId`, issues);
    nonempty(row.signatureCode, `${p}.signatureCode`, issues, 64);
    nullableString(row.sourceSignatureId, `${p}.sourceSignatureId`, issues);
    nullableString(row.sourceConnectionId, `${p}.sourceConnectionId`, issues);
    if (row.connectedEveSystemId !== null) eveId(row.connectedEveSystemId, `${p}.connectedEveSystemId`, issues);
    enumValue(row.status, ["active", "inactive", "unknown"] as const, `${p}.status`, issues);
    nullableString(row.size, `${p}.size`, issues, 64);
    timestamp(row.observedAt, `${p}.observedAt`, issues, true);
    timestamp(row.freshUntil, `${p}.freshUntil`, issues, true);
  });

  if (!Array.isArray(input.connections)) issues.push({ path: "$.connections", reason: "expected an array" });
  else input.connections.forEach((row, i) => {
    const p = `$.connections[${i}]`;
    if (!isRecord(row)) { issues.push({ path: p, reason: "expected an object" }); return; }
    strictKeys(row, ["sourceConnectionId", "fromEveSystemId", "toEveSystemId", "state", "observedAt", "freshUntil", "fromSignatureKey", "toSignatureKey"], p, issues);
    nonempty(row.sourceConnectionId, `${p}.sourceConnectionId`, issues);
    eveId(row.fromEveSystemId, `${p}.fromEveSystemId`, issues);
    eveId(row.toEveSystemId, `${p}.toEveSystemId`, issues);
    enumValue(row.state, ["active", "broken", "expired", "unknown"] as const, `${p}.state`, issues);
    timestamp(row.observedAt, `${p}.observedAt`, issues, true);
    timestamp(row.freshUntil, `${p}.freshUntil`, issues, true);
    nullableString(row.fromSignatureKey, `${p}.fromSignatureKey`, issues);
    nullableString(row.toSignatureKey, `${p}.toSignatureKey`, issues);
  });

  if (!isRecord(input.authorityMetadata)) issues.push({ path: "$.authorityMetadata", reason: "expected an object" });
  else {
    strictKeys(input.authorityMetadata, ["confirmed", "fields"], "$.authorityMetadata", issues);
    if (input.authorityMetadata.confirmed !== false || input.authorityMetadata.fields !== null)
      issues.push({ path: "$.authorityMetadata", reason: "fixture authority must remain explicitly unconfirmed" });
  }

  if (input.sourceMetadata !== undefined) {
    const boundedJson = (value: unknown, depth = 0): boolean => {
      if (depth > 32) return false;
      if (value === null || typeof value === "string" || typeof value === "boolean") return true;
      if (typeof value === "number") return Number.isFinite(value);
      if (Array.isArray(value)) return value.length <= 20_000 && value.every(item => boundedJson(item, depth + 1));
      return isRecord(value) && Object.keys(value).length <= 2_000 && Object.values(value).every(item => boundedJson(item, depth + 1));
    };
    if (!boundedJson(input.sourceMetadata)) issues.push({ path: "$.sourceMetadata", reason: "expected bounded JSON source fields" });
  }

  if (issues.length) return { ok: false, issues };
  const value = input as unknown as WormholeSystemsFixture;
  const systemIds = value.systems.map(row => row.eveSolarSystemId);
  const scopeIds = value.scope.eveSolarSystemIds;
  const systemSet = new Set(systemIds), scopeSet = new Set(scopeIds);
  if (systemSet.size !== systemIds.length) issues.push({ path: "$.systems", reason: "duplicate EVE system identity" });
  if (scopeSet.size !== scopeIds.length) issues.push({ path: "$.scope.eveSolarSystemIds", reason: "duplicate EVE system identity" });
  if (systemSet.size !== scopeSet.size || [...systemSet].some(id => !scopeSet.has(id)))
    issues.push({ path: "$.systems", reason: "systems do not exactly match declared map scope" });

  const signatureByKey = new Map<string, WormholeSystemsFixture["signatures"][number]>();
  const identitySet = new Set<string>();
  for (const [i, signature] of value.signatures.entries()) {
    if (signatureByKey.has(signature.signatureKey)) issues.push({ path: `$.signatures[${i}].signatureKey`, reason: "duplicate signature key" });
    signatureByKey.set(signature.signatureKey, signature);
    const key = identity(signature.scannerEveSystemId, signature.signatureCode, signature.sourceSignatureId);
    if (identitySet.has(key)) issues.push({ path: `$.signatures[${i}]`, reason: "duplicate directional signature identity" });
    identitySet.add(key);
    if (!systemSet.has(signature.scannerEveSystemId)) issues.push({ path: `$.signatures[${i}].scannerEveSystemId`, reason: "scanner system is outside map scope" });
    if (signature.connectedEveSystemId !== null && !systemSet.has(signature.connectedEveSystemId))
      issues.push({ path: `$.signatures[${i}].connectedEveSystemId`, reason: "connected system is outside map scope" });
  }
  const connectionIds = new Set<string>();
  for (const [i, connection] of value.connections.entries()) {
    if (connectionIds.has(connection.sourceConnectionId)) issues.push({ path: `$.connections[${i}].sourceConnectionId`, reason: "duplicate connection identity" });
    connectionIds.add(connection.sourceConnectionId);
    if (connection.fromEveSystemId === connection.toEveSystemId) issues.push({ path: `$.connections[${i}]`, reason: "connection endpoints must differ" });
    if (!systemSet.has(connection.fromEveSystemId) || !systemSet.has(connection.toEveSystemId))
      issues.push({ path: `$.connections[${i}]`, reason: "connection endpoint is outside map scope" });
    for (const [key, endpoint, other] of [[connection.fromSignatureKey, connection.fromEveSystemId, connection.toEveSystemId], [connection.toSignatureKey, connection.toEveSystemId, connection.fromEveSystemId]] as const) {
      if (key === null) continue;
      const signature = signatureByKey.get(key);
      if (!signature) issues.push({ path: `$.connections[${i}]`, reason: "connection references an unknown signature" });
      else if (signature.scannerEveSystemId !== endpoint || signature.connectedEveSystemId !== other || signature.sourceConnectionId !== connection.sourceConnectionId)
        issues.push({ path: `$.connections[${i}]`, reason: "directional signature reference contradicts connection endpoints or identity" });
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, value };
}

/** Validate, copy and canonicalize ordering/timestamps without inventing fields. */
export function normalizeWormholeSystemsFixture(input: unknown): FixtureValidationResult {
  const validated = validateWormholeSystemsFixture(input);
  if (!validated.ok) return validated;
  const value = structuredClone(validated.value);
  const canonicalTime = (date: string | null) => date === null ? null : new Date(date).toISOString();
  value.fetchedAt = canonicalTime(value.fetchedAt)!;
  value.observedAt = canonicalTime(value.observedAt);
  value.scope.eveSolarSystemIds.sort((a, b) => a - b);
  value.systems.sort((a, b) => a.eveSolarSystemId - b.eveSolarSystemId);
  for (const system of value.systems) system.observedAt = canonicalTime(system.observedAt);
  value.signatures.sort((a, b) => a.scannerEveSystemId - b.scannerEveSystemId || a.signatureCode.localeCompare(b.signatureCode) || String(a.sourceSignatureId).localeCompare(String(b.sourceSignatureId)) || a.signatureKey.localeCompare(b.signatureKey));
  for (const signature of value.signatures) {
    signature.observedAt = canonicalTime(signature.observedAt);
    signature.freshUntil = canonicalTime(signature.freshUntil);
  }
  value.connections.sort((a, b) => a.sourceConnectionId.localeCompare(b.sourceConnectionId));
  for (const connection of value.connections) {
    connection.observedAt = canonicalTime(connection.observedAt);
    connection.freshUntil = canonicalTime(connection.freshUntil);
  }
  return { ok: true, value };
}

export type PreviewDirection = {
  source: WormholeSystemsFixture;
  connection: WormholeSystemsFixture["connections"][number];
  signature: WormholeSystemsFixture["signatures"][number];
  fromEveSystemId: number;
  toEveSystemId: number;
  nexum: NexumPreviewFixture;
};
export type WormholePreview = {
  fixtureOnly: true;
  writeEligible: false;
  canonicalMapId: string;
  sourceRevision: string;
  matched: Array<{
    sourceConnectionId: string;
    sourceSignatureKey: string;
    nexumSystemId: string;
    nexumSignatureRowId: string;
    direction: { fromEveSystemId: number; toEveSystemId: number };
    status: string;
    size: string | null;
    currentNotes: string | null;
    renderedNotes: string;
    action: "update" | "unchanged";
  }>;
  skipped: Array<{ sourceConnectionId: string | null; sourceSignatureKey: string | null; reason: string }>;
};

/**
 * Deterministic, local-only matching mechanics. The required renderer is
 * supplied by explicitly synthetic tests; no authority-backed template is
 * defined here and every result remains non-writable.
 */
export function planSyntheticWormholePreview(
  source: WormholeSystemsFixture,
  nexum: NexumPreviewFixture,
  options: { now: number; maxAgeMs: number; renderBookmark: (direction: PreviewDirection) => string | null },
): WormholePreview {
  const result: WormholePreview = { fixtureOnly: true, writeEligible: false, canonicalMapId: source.scope.canonicalMapId, sourceRevision: source.revisionOrDigest, matched: [], skipped: [] };
  const skip = (connectionId: string | null, signatureKey: string | null, reason: string) => result.skipped.push({ sourceConnectionId: connectionId, sourceSignatureKey: signatureKey, reason });
  const fresh = (at: string | null, until?: string | null) => !!at && Date.parse(at) <= options.now && options.now - Date.parse(at) <= options.maxAgeMs && (!until || Date.parse(until) >= options.now);
  if (!Number.isFinite(options.now) || !Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) throw new Error("Invalid fixture preview clock or freshness bound");
  if (source.scope.canonicalMapId !== nexum.canonicalMapId) {
    for (const connection of source.connections) skip(connection.sourceConnectionId, null, "canonical map identity mismatch");
    return result;
  }
  if (source.sourceKind === "wormholesystems" || source.authorityMetadata.confirmed || source.fixtureOnly !== true || nexum.fixtureOnly !== true) {
    for (const connection of source.connections) skip(connection.sourceConnectionId, null, "non-synthetic or unconfirmed fixture boundary required");
    return result;
  }
  if (!fresh(source.fetchedAt) || !fresh(source.observedAt) || !fresh(nexum.fetchedAt)) {
    for (const connection of source.connections) skip(connection.sourceConnectionId, null, "source or Nexum snapshot is stale or missing observation time");
    return result;
  }

  const sourceSignatureKeys = new Set<string>();
  if (source.signatures.some(signature => {
    if (sourceSignatureKeys.has(signature.signatureKey)) return true;
    sourceSignatureKeys.add(signature.signatureKey);
    return false;
  })) {
    for (const connection of source.connections) skip(connection.sourceConnectionId, null, "duplicate source signature keys make fixture identities ambiguous");
    return result;
  }

  const nexumSystemToEve = new Map<string, number>();
  const eveToNexumSystem = new Map<number, string>();
  const contradictorySystemMapping = nexum.systems.some(system => {
    const mappedEveId = nexumSystemToEve.get(system.nexumSystemId);
    const mappedNexumId = eveToNexumSystem.get(system.eveSolarSystemId);
    if ((mappedEveId !== undefined && mappedEveId !== system.eveSolarSystemId) ||
        (mappedNexumId !== undefined && mappedNexumId !== system.nexumSystemId)) return true;
    nexumSystemToEve.set(system.nexumSystemId, system.eveSolarSystemId);
    eveToNexumSystem.set(system.eveSolarSystemId, system.nexumSystemId);
    return false;
  });
  if (contradictorySystemMapping) {
    for (const connection of source.connections) skip(connection.sourceConnectionId, null, "Nexum system ID and EVE system ID mapping is contradictory");
    return result;
  }

  const srcSig = new Map(source.signatures.map(signature => [signature.signatureKey, signature]));
  const sourceSystems = new Map(source.systems.map(system => [system.eveSolarSystemId, system]));
  const systemRows = new Map<number, NexumPreviewFixture["systems"]>();
  for (const system of nexum.systems) systemRows.set(system.eveSolarSystemId, [...(systemRows.get(system.eveSolarSystemId) ?? []), system]);
  const usedNexumConnections = new Set<string>();
  const allConnections: Array<{ source: WormholeSystemsFixture["connections"][number]; candidates: Array<{ edge: NexumPreviewFixture["connections"][number]; fromRow: NexumPreviewFixture["signatures"][number]; toRow: NexumPreviewFixture["signatures"][number]; fromSystem: NexumPreviewFixture["systems"][number] }> }> = [];

  for (const connection of source.connections) {
    const fromKey = connection.fromSignatureKey, toKey = connection.toSignatureKey;
    const from = fromKey ? srcSig.get(fromKey) : undefined, to = toKey ? srcSig.get(toKey) : undefined;
    if (connection.state !== "active") { skip(connection.sourceConnectionId, null, `source connection state is ${connection.state}`); continue; }
    if (!fresh(connection.observedAt, connection.freshUntil)) { skip(connection.sourceConnectionId, null, "source connection is stale or missing freshness evidence"); continue; }
    const sourceFrom = sourceSystems.get(connection.fromEveSystemId), sourceTo = sourceSystems.get(connection.toEveSystemId);
    if (!sourceFrom || !sourceTo || sourceFrom.status !== "known" || sourceTo.status !== "known") { skip(connection.sourceConnectionId, null, "source endpoint system status is unknown"); continue; }
    if (!fresh(sourceFrom.observedAt) || !fresh(sourceTo.observedAt)) { skip(connection.sourceConnectionId, null, "source endpoint system is stale or missing observation time"); continue; }
    // Directional-only authority is unresolved. Even fixture previews therefore require both directions.
    if (!from || !to) { skip(connection.sourceConnectionId, fromKey ?? toKey, "both directional signatures are required; directional-only authority is unresolved"); continue; }
    const invalidDirection = [from, to].find(signature => signature.status !== "active" || signature.sourceConnectionId !== connection.sourceConnectionId || !fresh(signature.observedAt, signature.freshUntil));
    if (invalidDirection) { skip(connection.sourceConnectionId, invalidDirection.signatureKey, invalidDirection.status !== "active" ? `source signature status is ${invalidDirection.status}` : "source signature is stale or missing freshness evidence"); continue; }
    const fromSystems = systemRows.get(connection.fromEveSystemId) ?? [], toSystems = systemRows.get(connection.toEveSystemId) ?? [];
    if (fromSystems.length !== 1 || toSystems.length !== 1) { skip(connection.sourceConnectionId, null, "Nexum EVE system identity is missing or ambiguous"); continue; }
    const fromSystem = fromSystems[0], toSystem = toSystems[0];
    if (fromSystem.status !== "active" || toSystem.status !== "active") { skip(connection.sourceConnectionId, null, "Nexum endpoint system status is unknown"); continue; }
    const rowById = (systemId: string, rowId: string | null) => nexum.signatures.filter(row => row.nexumSystemId === systemId && row.nexumSignatureRowId === rowId);
    const candidates: Array<{ edge: NexumPreviewFixture["connections"][number]; fromRow: NexumPreviewFixture["signatures"][number]; toRow: NexumPreviewFixture["signatures"][number]; fromSystem: NexumPreviewFixture["systems"][number] }> = [];
    for (const edge of nexum.connections) {
      if (edge.status !== "active") continue;
      const forward = edge.sourceSystemId === fromSystem.nexumSystemId && edge.targetSystemId === toSystem.nexumSystemId;
      const reverse = edge.sourceSystemId === toSystem.nexumSystemId && edge.targetSystemId === fromSystem.nexumSystemId;
      if (!forward && !reverse) continue;
      const fromRowId = forward ? edge.sourceSignatureRowId : edge.targetSignatureRowId;
      const toRowId = forward ? edge.targetSignatureRowId : edge.sourceSignatureRowId;
      const fromRows = rowById(fromSystem.nexumSystemId, fromRowId), toRows = rowById(toSystem.nexumSystemId, toRowId);
      if (fromRows.length !== 1 || toRows.length !== 1) continue;
      const fromRow = fromRows[0], toRow = toRows[0];
      if (fromRow.signatureCode !== from.signatureCode || toRow.signatureCode !== to.signatureCode) continue;
      if (fromRow.status !== "active" || toRow.status !== "active" || !fresh(fromRow.fetchedAt) || !fresh(toRow.fetchedAt) || !fresh(edge.observedAt)) continue;
      candidates.push({ edge, fromRow, toRow, fromSystem });
    }
    allConnections.push({ source: connection, candidates });
  }

  const candidateUseCounts = new Map<string, number>();
  for (const item of allConnections) for (const candidate of item.candidates)
    candidateUseCounts.set(candidate.edge.nexumConnectionId, (candidateUseCounts.get(candidate.edge.nexumConnectionId) ?? 0) + 1);
  for (const { source: connection, candidates } of allConnections) {
    const keys = [connection.fromSignatureKey, connection.toSignatureKey];
    if (candidates.length !== 1) {
      skip(connection.sourceConnectionId, null, candidates.length ? "multiple Nexum connections match the directional identities" : "no exact Nexum connection and directional signature match");
      continue;
    }
    const candidate = candidates[0];
    if ((candidateUseCounts.get(candidate.edge.nexumConnectionId) ?? 0) !== 1 || usedNexumConnections.has(candidate.edge.nexumConnectionId)) {
      skip(connection.sourceConnectionId, null, "Nexum connection would be reused by multiple source connections");
      continue;
    }
    usedNexumConnections.add(candidate.edge.nexumConnectionId);
    for (const [signatureKey, row, fromEveSystemId, toEveSystemId] of [
      [keys[0], candidate.fromRow, connection.fromEveSystemId, connection.toEveSystemId],
      [keys[1], candidate.toRow, connection.toEveSystemId, connection.fromEveSystemId],
    ] as const) {
      const signature = signatureKey ? srcSig.get(signatureKey) : undefined;
      if (!signature) { skip(connection.sourceConnectionId, signatureKey, "directional signature reference is missing"); continue; }
      const renderedNotes = options.renderBookmark({ source, connection, signature, fromEveSystemId, toEveSystemId, nexum });
      if (typeof renderedNotes !== "string" || !renderedNotes.trim() || renderedNotes.length > 1024) {
        skip(connection.sourceConnectionId, signature.signatureKey, "synthetic bookmark renderer did not provide a bounded note");
        continue;
      }
      result.matched.push({ sourceConnectionId: connection.sourceConnectionId, sourceSignatureKey: signature.signatureKey,
        nexumSystemId: row.nexumSystemId, nexumSignatureRowId: row.nexumSignatureRowId,
        direction: { fromEveSystemId, toEveSystemId }, status: signature.status, size: signature.size,
        currentNotes: row.notes, renderedNotes, action: row.notes === renderedNotes ? "unchanged" : "update" });
    }
  }
  result.matched.sort((a, b) => a.sourceConnectionId.localeCompare(b.sourceConnectionId) || a.direction.fromEveSystemId - b.direction.fromEveSystemId || a.nexumSignatureRowId.localeCompare(b.nexumSignatureRowId));
  result.skipped.sort((a, b) => String(a.sourceConnectionId).localeCompare(String(b.sourceConnectionId)) || String(a.sourceSignatureKey).localeCompare(String(b.sourceSignatureKey)) || a.reason.localeCompare(b.reason));
  return result;
}
