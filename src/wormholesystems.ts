import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDatabase } from "./database.js";
import { getStateDatabase } from "./persistence.js";
import { SecretStore } from "./secrets.js";
import { getNexum } from "./nexum.js";
import { NexumStore, type Json } from "./nexum-store.js";
import { containsSecretValue, normalizeSourceSnapshot, validateSourceMapDetail } from "./wormholesystems-adapter.js";
import { mapDecisionBoundary } from "./map-decision-boundary.js";
import {
  WormholeSystemsClient, WormholeSystemsError, validateWormholeSystemsOrigin,
  validateWormholeSystemsPathPrefix, type ApiMapRecord, type WormholeSystemsConfig,
  type WormholeSystemsTransport,
} from "./wormholesystems-client.js";
import { allianceNoteWriteEligibility, renderAllianceNote, summarizeTopologyWriteResponse, topologyCandidateFromFixture,
  validateWormholesystemsTopologyRequest } from "./wormholesystems-reconciliation.js";
import { validateWormholeSystemsFixture, type ValidatedSourceSignatureEvidence, type WormholeSystemsFixture } from "./wormholesystems-fixture.js";
import type { WormholesystemsSignatureNoteIdentity } from "./nexum.js";

const MAX_SYSTEM_DETAIL_REQUESTS = 100;
const SYSTEM_DETAIL_PACING_MS = 1_000;
const MAX_SOURCE_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const APPROVED_MAX_STALENESS_MS = 60_000;
const SOURCE_WRITE_BLOCKER = "final-name reconciliation is disabled; source topology and alliance-note write eligibility are evaluated independently";
const opaqueId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
};
const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}` : JSON.stringify(value);
const safeError = (error: unknown): { status: number; message: string } => error instanceof WormholeSystemsError
  ? { status: error.status, message: error.message }
  : { status: 0, message: "WormholeSystems operation failed" };

type SourceConfig = WormholeSystemsConfig & {
  canonicalMapId: string;
  upstreamMapId: string;
  credentialId: string;
  configuredAt: number;
  configurationRevision: string;
  liveSyncEnabled: boolean;
  schemaValidatedAt: number | null;
  validatedCredentialId: string | null;
  validatedApiMapId: string | null;
  max_staleness_ms?: unknown;
  staleness_policy_origin?: unknown;
  staleness_policy_revision?: unknown;
};
type StalenessPolicy = { max_age_ms: number; origin: "approved_default" | "operator"; revision: string };
type PolicyState = { policy: StalenessPolicy | null; valid: boolean };
type SourceNexumWrites = {
  writeWormholesystemsTopology(mapId: string, request: Record<string, unknown>): Promise<Json>;
  writeWormholesystemsSignatureNotes(mapId: string, changes: Array<{ systemId: string; signatureId: string; notes: string;
    expectedIdentity: WormholesystemsSignatureNoteIdentity }>, validateSource: () => string[]): Promise<Json>;
};

export function canonicalSolarSystemClassFromSde(db: Pick<Database.Database, "prepare">, eveSystemId: number): string | null {
  try {
    const row = db.prepare(`SELECT s.security, w.wormholeClassID
      FROM mapSolarSystems s LEFT JOIN mapLocationWormholeClasses w ON w.locationID=s.solarSystemID
      WHERE s.solarSystemID=?`).get(eveSystemId) as { security: number | null; wormholeClassID: number | null } | undefined;
    if (!row) return null;
    if (Number.isSafeInteger(row.wormholeClassID) && Number(row.wormholeClassID) >= 1 && Number(row.wormholeClassID) <= 6)
      return `C${row.wormholeClassID}`;
    // Special wormhole classes are intentionally not guessed from security.
    if (row.wormholeClassID !== null) return null;
    if (typeof row.security !== "number" || !Number.isFinite(row.security)) return null;
    if (row.security === -1) return null;
    return row.security >= 0.5 ? "HS" : row.security > 0 ? "LS" : "NS";
  } catch {
    return null;
  }
}

export function canonicalSolarSystemClass(eveSystemId: number): string | null {
  try { return canonicalSolarSystemClassFromSde(getDatabase(), eveSystemId); }
  catch { return null; }
}

export class WormholeSystemsService {
  private readonly lifetime = new AbortController();
  private readonly syncs = new Map<string, Promise<Json>>();
  private readonly operations = new Set<Promise<unknown>>();
  private stopping = false;
  constructor(
    readonly store: NexumStore,
    private readonly secrets: Pick<SecretStore, "put" | "get" | "remove">,
    private readonly transport: WormholeSystemsTransport = fetch,
    private readonly now: () => number = store.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly nexumWrites?: SourceNexumWrites,
    private readonly systemClass: (eveSystemId: number) => string | null = canonicalSolarSystemClass,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS wormholesystems_credentials (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wormholesystems_config (id TEXT PRIMARY KEY CHECK(id='singleton'), config_json TEXT NOT NULL CHECK(json_valid(config_json)));
      CREATE TABLE IF NOT EXISTS wormholesystems_policy_state (id TEXT PRIMARY KEY CHECK(id='singleton'), initialized INTEGER NOT NULL CHECK(initialized=1), default_revision TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS wormholesystems_source_snapshots (
        map_id TEXT PRIMARY KEY REFERENCES nexum_maps(id) ON DELETE CASCADE,
        source_identity TEXT NOT NULL, source_origin TEXT NOT NULL, source_api_map_id TEXT NOT NULL,
        revision_or_digest TEXT NOT NULL, fetched_at TEXT NOT NULL, observed_at TEXT,
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), eligible_for_matching INTEGER NOT NULL CHECK(eligible_for_matching IN (0,1)),
           credential_id TEXT NOT NULL DEFAULT '', credential_version INTEGER NOT NULL DEFAULT 0, source_configured_at INTEGER NOT NULL DEFAULT 0,
           source_config_revision TEXT NOT NULL DEFAULT ''
      );
       CREATE TABLE IF NOT EXISTS wormholesystems_source_runs (
         id INTEGER PRIMARY KEY, map_id TEXT NOT NULL REFERENCES nexum_maps(id) ON DELETE CASCADE,
         status TEXT NOT NULL, attempted_at INTEGER NOT NULL, succeeded_at INTEGER, revision_or_digest TEXT, error_status INTEGER, error_message TEXT,
         source_calls INTEGER NOT NULL DEFAULT 0, revision_ordering TEXT NOT NULL DEFAULT 'unknown', write_outcomes_json TEXT
       );
      CREATE INDEX IF NOT EXISTS wormholesystems_source_runs_map_time ON wormholesystems_source_runs(map_id,attempted_at);
    `);
    const columns = new Set((store.db.prepare("PRAGMA table_info(wormholesystems_source_snapshots)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("source_identity")) store.db.exec("ALTER TABLE wormholesystems_source_snapshots ADD COLUMN source_identity TEXT NOT NULL DEFAULT ''");
    if (!columns.has("source_origin")) store.db.exec("ALTER TABLE wormholesystems_source_snapshots ADD COLUMN source_origin TEXT NOT NULL DEFAULT ''");
    if (!columns.has("observed_at")) store.db.exec("ALTER TABLE wormholesystems_source_snapshots ADD COLUMN observed_at TEXT");
    if (!columns.has("credential_id")) store.db.exec("ALTER TABLE wormholesystems_source_snapshots ADD COLUMN credential_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("credential_version")) store.db.exec("ALTER TABLE wormholesystems_source_snapshots ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("source_configured_at")) store.db.exec("ALTER TABLE wormholesystems_source_snapshots ADD COLUMN source_configured_at INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("source_config_revision")) store.db.exec("ALTER TABLE wormholesystems_source_snapshots ADD COLUMN source_config_revision TEXT NOT NULL DEFAULT ''");
    const snapshotSql = (store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wormholesystems_source_snapshots'").get() as { sql: string } | undefined)?.sql ?? "";
    if (/eligible_for_matching\s*=\s*0/i.test(snapshotSql)) {
      store.db.transaction(() => {
        store.db.exec(`CREATE TABLE wormholesystems_source_snapshots_v2 (
          map_id TEXT PRIMARY KEY REFERENCES nexum_maps(id) ON DELETE CASCADE,
          source_identity TEXT NOT NULL, source_origin TEXT NOT NULL, source_api_map_id TEXT NOT NULL,
          revision_or_digest TEXT NOT NULL, fetched_at TEXT NOT NULL, observed_at TEXT,
          payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), eligible_for_matching INTEGER NOT NULL CHECK(eligible_for_matching IN (0,1)),
          credential_id TEXT NOT NULL DEFAULT '', credential_version INTEGER NOT NULL DEFAULT 0, source_configured_at INTEGER NOT NULL DEFAULT 0,
          source_config_revision TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO wormholesystems_source_snapshots_v2 (map_id,source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json,eligible_for_matching)
          SELECT map_id,source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json,eligible_for_matching FROM wormholesystems_source_snapshots;
        DROP TABLE wormholesystems_source_snapshots;
        ALTER TABLE wormholesystems_source_snapshots_v2 RENAME TO wormholesystems_source_snapshots;`);
      })();
    }
    const runColumns = new Set((store.db.prepare("PRAGMA table_info(wormholesystems_source_runs)").all() as Array<{ name: string }>).map(column => column.name));
    if (!runColumns.has("error_message")) store.db.exec("ALTER TABLE wormholesystems_source_runs ADD COLUMN error_message TEXT");
    if (!runColumns.has("source_calls")) store.db.exec("ALTER TABLE wormholesystems_source_runs ADD COLUMN source_calls INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.has("revision_ordering")) store.db.exec("ALTER TABLE wormholesystems_source_runs ADD COLUMN revision_ordering TEXT NOT NULL DEFAULT 'unknown'");
    if (!runColumns.has("write_outcomes_json")) store.db.exec("ALTER TABLE wormholesystems_source_runs ADD COLUMN write_outcomes_json TEXT");
    this.initializeStalenessPolicy();
  }

  private config(): SourceConfig | undefined {
    const row = this.store.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as { config_json: string } | undefined;
    if (!row) return undefined;
    let value: unknown;
    try { value = JSON.parse(row.config_json); } catch { return undefined; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const config = value as SourceConfig;
    return { ...config, configurationRevision: config.configurationRevision ?? `legacy:${config.configuredAt}`,
      liveSyncEnabled: config.liveSyncEnabled === true, schemaValidatedAt: config.schemaValidatedAt ?? null,
      validatedCredentialId: config.validatedCredentialId ?? null, validatedApiMapId: config.validatedApiMapId ?? null };
  }

  private saveConfig(value: SourceConfig): void {
    this.store.db.prepare("INSERT INTO wormholesystems_config(id,config_json) VALUES ('singleton',?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json")
      .run(JSON.stringify(value));
  }

  private metadata(id: string): Json {
    const row = this.store.db.prepare("SELECT metadata FROM wormholesystems_credentials WHERE id=?").get(id) as { metadata: string } | undefined;
    if (!row) throw new Error("WormholeSystems credential not found");
    return JSON.parse(row.metadata);
  }

  private validPolicyFields(config: SourceConfig): StalenessPolicy | null {
    const value = config.max_staleness_ms;
    const origin = config.staleness_policy_origin;
    const revision = config.staleness_policy_revision;
    if (!Number.isSafeInteger(value) || Number(value) <= 0 || (origin !== "approved_default" && origin !== "operator") ||
        (origin === "approved_default" && Number(value) !== APPROVED_MAX_STALENESS_MS) ||
        typeof revision !== "string" || !revision.trim() || revision !== revision.trim() || revision.length > 256) return null;
    return { max_age_ms: Number(value), origin, revision };
  }

  private initializeStalenessPolicy(): void {
    this.store.db.transaction(() => {
      const marker = this.store.db.prepare("SELECT initialized,default_revision FROM wormholesystems_policy_state WHERE id='singleton'").get() as
        { initialized: number; default_revision: string } | undefined;
      const row = this.store.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as { config_json: string } | undefined;
      if (marker) return;
      let defaultRevision: string = crypto.randomUUID();
      if (row) {
        let raw: unknown;
        try { raw = JSON.parse(row.config_json); } catch { return; }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        const configValues = raw as Record<string, unknown>;
        const fieldNames = ["max_staleness_ms", "staleness_policy_origin", "staleness_policy_revision"];
        const presentCount = fieldNames.filter(field => Object.hasOwn(configValues, field)).length;
        if (presentCount) {
          if (presentCount !== fieldNames.length) return;
          const existing = this.validPolicyFields(configValues as SourceConfig);
          if (!existing) return;
          if (existing.origin === "approved_default") defaultRevision = existing.revision;
        } else {
          const config = { ...configValues, max_staleness_ms: APPROVED_MAX_STALENESS_MS,
            staleness_policy_origin: "approved_default", staleness_policy_revision: defaultRevision };
          this.store.db.prepare("UPDATE wormholesystems_config SET config_json=? WHERE id='singleton'").run(JSON.stringify(config));
        }
      }
      this.store.db.prepare("INSERT INTO wormholesystems_policy_state(id,initialized,default_revision) VALUES ('singleton',1,?)")
        .run(defaultRevision);
    })();
  }

  private policyState(config = this.config()): PolicyState {
    const marker = this.store.db.prepare("SELECT initialized,default_revision FROM wormholesystems_policy_state WHERE id='singleton'").get() as
      { initialized: number; default_revision: string } | undefined;
    if (!marker || marker.initialized !== 1 || typeof marker.default_revision !== "string" || !marker.default_revision.trim() ||
        marker.default_revision !== marker.default_revision.trim() || marker.default_revision.length > 256)
      return { policy: null, valid: false };
    if (!config) {
      const persistedConfig = this.store.db.prepare("SELECT 1 FROM wormholesystems_config WHERE id='singleton'").get();
      if (persistedConfig) return { policy: null, valid: false };
      return { policy: { max_age_ms: APPROVED_MAX_STALENESS_MS, origin: "approved_default", revision: marker.default_revision }, valid: true };
    }
    const policy = this.validPolicyFields(config);
    if (policy?.origin === "approved_default" && policy.revision !== marker.default_revision) return { policy: null, valid: false };
    return policy ? { policy, valid: true } : { policy: null, valid: false };
  }

  private resetPolicyState(revision = crypto.randomUUID()): void {
    this.store.db.prepare("INSERT INTO wormholesystems_policy_state(id,initialized,default_revision) VALUES ('singleton',1,?) ON CONFLICT(id) DO UPDATE SET initialized=1,default_revision=excluded.default_revision")
      .run(revision);
  }

  private withMapBoundarySync<T>(mapIds: string[], operation: () => T): T {
    const result = mapDecisionBoundary.runManySync(mapIds, operation);
    if (!result.acquired) throw new Error("Nexum map decision is currently in progress");
    return result.value;
  }

  private client(config = this.config()): WormholeSystemsClient {
    if (!config) throw new Error("WormholeSystems source is not configured");
    return new WormholeSystemsClient(config, this.token(config), this.transport);
  }

  private token(config: SourceConfig): string { return this.secrets.get(this.metadata(config.credentialId).secret_ref); }

  private rejectSecretEcho(maps: ApiMapRecord[], token: string): void {
    if (maps.some(map => containsSecretValue(map, token)))
      throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems maps response");
  }

  private selectedMap(maps: ApiMapRecord[], config: SourceConfig): ApiMapRecord | undefined {
    const matches = maps.filter(map => config.mapRouteKey === "id" ? map.id === config.upstreamMapId : map.slug === config.upstreamMapId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("WormholeSystems service is stopping"));
    const task = Promise.resolve().then(operation);
    this.operations.add(task);
    void task.finally(() => this.operations.delete(task)).catch(() => undefined);
    return task;
  }

  async stop(): Promise<void> {
    if (!this.stopping) { this.stopping = true; this.lifetime.abort(); }
    await Promise.allSettled([...this.operations]);
  }

  private assertNoActiveSync(): void {
    if (this.stopping) throw new Error("WormholeSystems service is stopping");
    if (this.operations.size || this.syncs.size) throw new Error("WormholeSystems configuration cannot change during a source operation");
  }

  private canonicalMap(id: string): string {
    const mapId = opaqueId(id, "canonical map ID");
    const resolved = this.store.map(mapId);
    if (resolved.id !== mapId) throw new Error("WormholeSystems requires a canonical map ID, not a map name");
    return mapId;
  }

  private assertTokenDoesNotMatchConfig(token: string, values: Record<string, unknown>): void {
    if (Object.values(values).some(value => typeof value === "string" && value.includes(token)))
      throw new Error("Credential value cannot match any source configuration field");
  }

  private assertConfigDoesNotContainCredential(config: SourceConfig): void {
    this.assertTokenDoesNotMatchConfig(this.token(config), { origin: config.origin, apiPathPrefix: config.apiPathPrefix,
      mapRouteKey: config.mapRouteKey, canonicalMapId: config.canonicalMapId, upstreamMapId: config.upstreamMapId,
      credentialId: config.credentialId });
  }

  configure(input: { origin: string; api_path_prefix: string; map_route_key: "id" | "slug"; canonical_map_id: string; upstream_map_id: string; credential_id: string }): Json {
    this.assertNoActiveSync();
    const origin = validateWormholeSystemsOrigin(input.origin);
    const apiPathPrefix = validateWormholeSystemsPathPrefix(input.api_path_prefix);
    if (input.map_route_key !== "id" && input.map_route_key !== "slug") throw new Error("Invalid WormholeSystems map route-key mode");
    const canonicalMapId = opaqueId(input.canonical_map_id, "canonical map ID");
    const upstreamMapId = opaqueId(input.upstream_map_id, "upstream map ID");
    const credentialId = opaqueId(input.credential_id, "credential ID");
    const resolvedMap = this.store.map(canonicalMapId);
    if (resolvedMap.id !== canonicalMapId) throw new Error("WormholeSystems requires a canonical map ID, not a map name");
    const metadata = this.metadata(credentialId);
    const token = this.secrets.get(metadata.secret_ref);
    const configFields = { origin, apiPathPrefix, mapRouteKey: input.map_route_key, canonicalMapId: resolvedMap.id, upstreamMapId, credentialId };
    this.assertTokenDoesNotMatchConfig(token, configFields);
    const existing = this.config();
    if (existing) this.assertTokenDoesNotMatchConfig(this.token(existing), configFields);
    this.withMapBoundarySync([...(existing ? [existing.canonicalMapId] : []), canonicalMapId], () => this.store.db.transaction(() => {
      const latest = this.config();
      if (latest?.configurationRevision !== existing?.configurationRevision || latest?.canonicalMapId !== existing?.canonicalMapId)
        throw new Error("WormholeSystems source configuration changed; retry configuration");
      const policyState = this.policyState(latest);
      if (!policyState.valid || !policyState.policy) throw new Error("Persisted WormholeSystems staleness policy is invalid");
      const config: SourceConfig = { origin, apiPathPrefix, mapRouteKey: input.map_route_key, canonicalMapId,
        upstreamMapId, credentialId, configuredAt: this.now(), configurationRevision: crypto.randomUUID(),
        liveSyncEnabled: false, schemaValidatedAt: null, validatedCredentialId: null, validatedApiMapId: null,
        max_staleness_ms: policyState.policy.max_age_ms, staleness_policy_origin: policyState.policy.origin,
        staleness_policy_revision: policyState.policy.revision };
      this.saveConfig(config);
      for (const id of new Set([latest?.canonicalMapId, canonicalMapId].filter((value): value is string => !!value)))
        this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(id);
    })());
    return this.configuration();
  }

  configuration(): Json {
    const config = this.config();
    const policyState = this.policyState(config);
    const stalenessPolicy = policyState.policy ?? { max_age_ms: null, origin: "invalid", revision: null };
    if (!config) {
      const blockers = ["source configuration is not configured", ...(!policyState.valid ? ["invalid_persisted_policy"] : [])];
      return { configured: false, live_sync_enabled: false, eligible_for_matching: false,
        source_snapshot_eligible_for_matching: false, stored_snapshot_eligible_for_matching: false, eligible_for_writes: false,
        source_snapshot_blockers: blockers, nexum_matching_blockers: [],
        full_matching_blockers: blockers,
        staleness_policy: stalenessPolicy, ...(policyState.valid ? {} : { activation_blockers: ["invalid_persisted_policy"] }) };
    }
    this.assertConfigDoesNotContainCredential(config);
    const current = this.status(config.canonicalMapId) as Json;
    return { configured: true, origin: config.origin, api_path_prefix: config.apiPathPrefix, map_route_key: config.mapRouteKey,
      canonical_map_id: config.canonicalMapId, upstream_map_id: config.upstreamMapId, credential_id: config.credentialId,
      configured_at: config.configuredAt, schema_validated_at: config.schemaValidatedAt, live_sync_enabled: config.liveSyncEnabled,
      staleness_policy: current.staleness_policy ?? stalenessPolicy,
      stored_snapshot_eligible_for_matching: current.stored_snapshot_eligible_for_matching ?? false,
      source_snapshot_eligible_for_matching: current.source_snapshot_eligible_for_matching ?? false,
      source_snapshot_blockers: current.source_snapshot_blockers ?? [],
      nexum_matching_blockers: current.nexum_matching_blockers ?? [],
      full_matching_blockers: current.full_matching_blockers ?? current.matching_blockers ?? [],
      eligible_for_matching: current.eligible_for_matching ?? false, eligible_for_writes: current.eligible_for_writes ?? false,
      write_eligibility: current.write_eligibility ?? { topology: { eligible: false }, alliance_notes: { eligible: false } },
      activation_blockers: [...(config.schemaValidatedAt && config.validatedCredentialId === config.credentialId ? [] : ["run a successful connection and selected-map schema test"]),
        ...(config.liveSyncEnabled ? [] : ["source snapshot synchronization is not operator-enabled"]),
        ...(policyState.valid ? [] : ["invalid_persisted_policy"])] };
  }

  removeConfiguration(): Json {
    this.assertNoActiveSync();
    const config = this.config();
    this.withMapBoundarySync(config ? [config.canonicalMapId] : [], () => this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM wormholesystems_config WHERE id='singleton'").run();
      if (config) this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(config.canonicalMapId);
      this.resetPolicyState();
    })());
    return { ...(this.configuration() as Json), staleness_policy_reset: true };
  }

  setMaxStaleness(maxStalenessMs: unknown): Json {
    if (!Number.isSafeInteger(maxStalenessMs) || Number(maxStalenessMs) <= 0)
      return { committed: false, error: "max_staleness_ms must be a positive safe integer" };
    if (this.stopping) return { committed: false, error: "WormholeSystems service is stopping; policy was not changed", retryable: true };
    const initialConfig = this.config();
    const initialPolicy = this.policyState(initialConfig);
    if (!initialPolicy.valid || !initialPolicy.policy)
      return { committed: false, error: "invalid_persisted_policy; restore durable policy state before retrying" };
    if (!initialConfig) return { committed: false, error: "Configure a WormholeSystems source before setting the policy" };
    const result = mapDecisionBoundary.runSync(initialConfig.canonicalMapId, () => {
      if (this.stopping) return { committed: false, error: "WormholeSystems service is stopping; policy was not changed", retryable: true };
      try {
        return this.store.db.transaction(() => {
          const current = this.config();
          if (!current || current.canonicalMapId !== initialConfig.canonicalMapId)
            return { committed: false, error: "WormholeSystems configuration changed; retry after checking get_config", retryable: true };
          const currentPolicy = this.policyState(current);
          if (!currentPolicy.valid || !currentPolicy.policy)
            return { committed: false, error: "invalid_persisted_policy; restore durable policy state before retrying" };
          try { this.assertConfigDoesNotContainCredential(current); }
          catch { return { committed: false, error: "source configuration contains credential material; correct it before retrying" }; }
          const revision = crypto.randomUUID();
          this.saveConfig({ ...current, max_staleness_ms: Number(maxStalenessMs), staleness_policy_origin: "operator",
            staleness_policy_revision: revision });
          return { committed: true, staleness_policy: { max_age_ms: Number(maxStalenessMs), origin: "operator", revision } };
        })();
      } catch {
        return { error: "Policy persistence outcome is indeterminate; call get_config before retrying" };
      }
    });
    if (!result.acquired) return { committed: false, error: "Nexum map decision is currently in progress; retry after it completes", retryable: true };
    return result.value;
  }

  addCredential(input: { api_token: string; label?: string }): Json {
    if (typeof input.api_token !== "string" || !input.api_token.trim() || input.api_token.length > 4096 || /[\r\n]/.test(input.api_token))
      throw new Error("Invalid WormholeSystems credential");
    const label = input.label?.trim() || "WormholeSystems";
    if (label.length > 160 || label.includes(input.api_token)) throw new Error("Invalid credential label");
    const configured = this.config();
    if (configured) this.assertTokenDoesNotMatchConfig(input.api_token, { origin: configured.origin, apiPathPrefix: configured.apiPathPrefix,
      mapRouteKey: configured.mapRouteKey, canonicalMapId: configured.canonicalMapId, upstreamMapId: configured.upstreamMapId,
      credentialId: configured.credentialId });
    const id = crypto.randomUUID();
    const metadata = { id, label, secret_ref: id, created_at: this.now(), updated_at: this.now(), credential_version: 1, validation_status: "not_tested" };
    this.store.db.transaction(() => {
      this.secrets.put(id, input.api_token);
      this.store.db.prepare("INSERT INTO wormholesystems_credentials(id,metadata) VALUES (?,?)").run(id, JSON.stringify(metadata));
    })();
    return this.credentialResult(id);
  }

  credentialResult(id: string): Json {
    const { secret_ref: _secretRef, ...metadata } = this.metadata(id);
    return metadata;
  }

  listCredentials(): Json[] {
    return (this.store.db.prepare("SELECT id FROM wormholesystems_credentials ORDER BY id").all() as Array<{ id: string }>).map(row => this.credentialResult(row.id));
  }

  updateCredential(id: string, input: { api_token?: string; label?: string }): Json {
    this.assertNoActiveSync();
    const current = this.metadata(opaqueId(id, "credential ID"));
    const updated: Json = { ...current, updated_at: this.now() };
    if (input.label !== undefined) {
      const token = input.api_token ?? this.secrets.get(current.secret_ref);
      if (input.label.length > 160 || input.label.includes(token)) throw new Error("Invalid credential label");
      updated.label = input.label.trim();
    }
    if (input.api_token !== undefined) {
      if (!input.api_token.trim() || input.api_token.length > 4096 || /[\r\n]/.test(input.api_token) || updated.label.includes(input.api_token))
        throw new Error("Invalid WormholeSystems credential");
      const config = this.config();
      if (config) this.assertTokenDoesNotMatchConfig(input.api_token, { origin: config.origin, apiPathPrefix: config.apiPathPrefix,
        mapRouteKey: config.mapRouteKey, canonicalMapId: config.canonicalMapId, upstreamMapId: config.upstreamMapId, credentialId: config.credentialId });
      updated.validation_status = "not_tested";
      updated.credential_version = (Number(current.credential_version) || 1) + 1;
      const affectedMap = config?.credentialId === id ? config.canonicalMapId : undefined;
      this.withMapBoundarySync(affectedMap ? [affectedMap] : [], () => this.store.db.transaction(() => {
        this.secrets.put(current.secret_ref, input.api_token!);
        this.store.db.prepare("UPDATE wormholesystems_credentials SET metadata=? WHERE id=?").run(JSON.stringify(updated), id);
        if (config?.credentialId === id) {
          this.saveConfig({ ...config, configurationRevision: crypto.randomUUID(), liveSyncEnabled: false, schemaValidatedAt: null,
            validatedCredentialId: null, validatedApiMapId: null });
          this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(config.canonicalMapId);
        }
      })());
    } else this.store.db.prepare("UPDATE wormholesystems_credentials SET metadata=? WHERE id=?").run(JSON.stringify(updated), id);
    return this.credentialResult(id);
  }

  removeCredential(id: string): Json {
    this.assertNoActiveSync();
    const metadata = this.metadata(opaqueId(id, "credential ID"));
    const config = this.config();
    const affectedMap = config?.credentialId === id ? config.canonicalMapId : undefined;
    this.withMapBoundarySync(affectedMap ? [affectedMap] : [], () => this.store.db.transaction(() => {
      this.secrets.remove(metadata.secret_ref);
      this.store.db.prepare("DELETE FROM wormholesystems_credentials WHERE id=?").run(id);
      if (config?.credentialId === id) {
        this.store.db.prepare("DELETE FROM wormholesystems_config WHERE id='singleton'").run();
        this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(config.canonicalMapId);
        this.resetPolicyState();
      }
    })());
    const sourceConfigurationRemoved = config?.credentialId === id;
    return { removed: true, credential_id: id, source_configuration_removed: this.config() === undefined,
      ...(sourceConfigurationRemoved ? { staleness_policy_reset: true, staleness_policy: this.policyState().policy } : {}) };
  }

  private async fetchAccessibleMaps(): Promise<ApiMapRecord[]> {
    const config = this.config();
    if (!config) throw new Error("WormholeSystems source is not configured");
    const maps = await this.client(config).listMaps(this.lifetime.signal);
    this.rejectSecretEcho(maps, this.token(config));
    return maps;
  }

  private invalidateActivation(config: SourceConfig): void {
    const latest = this.config();
    if (!latest || latest.canonicalMapId !== config.canonicalMapId || latest.configurationRevision !== config.configurationRevision) return;
    this.saveConfig({ ...latest, configurationRevision: crypto.randomUUID(), liveSyncEnabled: false, schemaValidatedAt: null,
      validatedCredentialId: null, validatedApiMapId: null });
    this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(config.canonicalMapId);
  }

  private snapshotBlockers(mapId: string, row: any): string[] {
    const blockers: string[] = [];
    if (!row?.eligible_for_matching) blockers.push("stored source snapshot is marked ineligible");
    const config = this.config();
    const policyState = this.policyState(config);
    if (!policyState.valid || !policyState.policy) blockers.push("invalid_persisted_policy");
    const maxStalenessMs = policyState.policy?.max_age_ms;
    if (!config || config.canonicalMapId !== mapId) blockers.push("source configuration does not target this canonical map");
    else {
      if (!config.liveSyncEnabled) blockers.push("source synchronization is not currently enabled");
      if (!config.schemaValidatedAt || config.validatedCredentialId !== config.credentialId || !config.validatedApiMapId)
        blockers.push("current source credential has not passed the selected-map schema test");
      if (!config.validatedApiMapId || row.source_origin !== config.origin || row.source_api_map_id !== config.validatedApiMapId ||
          row.source_identity !== `wormholesystems:${JSON.stringify([config.origin, config.validatedApiMapId])}`)
        blockers.push("stored source identity does not match current source configuration");
      if (row.credential_id !== config.credentialId || Number(row.source_configured_at) !== config.configuredAt ||
          row.source_config_revision !== config.configurationRevision)
        blockers.push("stored snapshot credential or configuration revision does not match current configuration");
      try {
        const credentialVersion = Number(this.metadata(config.credentialId).credential_version) || 1;
        if (Number(row.credential_version) !== credentialVersion)
          blockers.push("stored snapshot credential version does not match current credential");
      } catch {
        blockers.push("current source credential is unavailable");
      }
    }
    const fetchedAt = row?.fetched_at ? Date.parse(row.fetched_at) : NaN;
    if (!Number.isFinite(fetchedAt) || fetchedAt > this.now()) blockers.push("source snapshot fetch time is missing or future-dated");
    else if (maxStalenessMs !== undefined && this.now() - fetchedAt > maxStalenessMs)
      blockers.push("source snapshot exceeds the configured maximum matching staleness");
    try {
      const payload = JSON.parse(row.payload_json);
      const fixture = payload?.fixture;
      const supportedSnapshotVersion = (payload?.schema === "wormholesystems-source-v1" && payload?.adapterVersion === 1 && fixture?.schemaVersion === 1) ||
        (payload?.schema === "wormholesystems-source-v2" && payload?.adapterVersion === 2 && fixture?.schemaVersion === 2);
      if (!supportedSnapshotVersion || fixture?.sourceKind !== "wormholesystems")
        blockers.push("stored snapshot does not match the validated adapter version");
      if (payload?.schema === "wormholesystems-source-v1" && payload?.adapterVersion === 1)
        blockers.push("source signature classification was not captured in this legacy v1 snapshot");
      if (fixture?.revisionOrDigest !== row.revision_or_digest || fixture?.sourceIdentity !== row.source_identity || fixture?.fetchedAt !== row.fetched_at)
        blockers.push("stored source snapshot fields do not match the validated fixture");
    } catch {
      blockers.push("stored source snapshot payload is unavailable or malformed");
    }
    return [...new Set(blockers)];
  }

  private targetCacheBlockers(mapId: string, sourceSystems: Json[], maxStalenessMs: number | undefined): string[] {
    const blockers: string[] = [];
    const now = this.now();
    let nexumMap: Json, nexumSystems: Json[];
    try {
      nexumMap = this.store.map(mapId);
      nexumSystems = (this.store.state(mapId).systems ?? []) as Json[];
    } catch {
      return ["Nexum target map or system identity is unavailable"];
    }
    const mapFetchedAt = nexumMap.hydrated_at === null || nexumMap.hydrated_at === undefined ? NaN : Number(nexumMap.hydrated_at);
    if (nexumMap.id !== mapId || nexumMap.health !== "live" || !Number.isFinite(mapFetchedAt) || mapFetchedAt > now ||
        maxStalenessMs === undefined || now - mapFetchedAt > maxStalenessMs)
      blockers.push("Nexum map cache is not live or exceeds the configured maximum staleness");
    for (const sourceSystem of sourceSystems) {
      const identities = nexumSystems.filter(system => Number(system.eveSystemId) === Number(sourceSystem.eveSolarSystemId));
      if (identities.length !== 1) {
        blockers.push("required Nexum system identity is missing or ambiguous");
        continue;
      }
      let fetchedAt = NaN;
      try {
        const resource = this.store.resources(mapId, String(identities[0].id)).signatures;
        fetchedAt = resource?.fetched_at === null || resource?.fetched_at === undefined ? NaN : Number(resource.fetched_at);
      } catch { /* malformed cache data is unavailable evidence */ }
      if (!Number.isFinite(fetchedAt) || fetchedAt > now || maxStalenessMs === undefined || now - fetchedAt > maxStalenessMs)
        blockers.push("Nexum signature cache is missing, future-dated or exceeds the configured maximum staleness");
    }
    return [...new Set(blockers)];
  }

  private allianceNoteSourceBlockers(mapId: string, expected: { revision: string; sourceIdentity: string; configurationRevision: string;
    policyRevision: string; nexumMapId: string }): string[] {
    const config = this.config();
    const snapshot = this.store.db.prepare("SELECT * FROM wormholesystems_source_snapshots WHERE map_id=?").get(mapId) as any;
    const blockers = snapshot ? this.snapshotBlockers(mapId, snapshot) : ["no current source snapshot is stored"];
    const policy = this.policyState(config).policy;
    try {
      const currentMap = this.store.map(mapId);
      if (currentMap.id !== mapId || currentMap.nexum_map_id !== expected.nexumMapId)
        blockers.push("Nexum target map identity changed after alliance-note preview");
    } catch { blockers.push("Nexum target map identity is unavailable"); }
    if (!config || config.canonicalMapId !== mapId || config.configurationRevision !== expected.configurationRevision)
      blockers.push("source configuration changed after alliance-note preview");
    if (!policy || policy.revision !== expected.policyRevision) blockers.push("staleness policy changed after alliance-note preview");
    if (!snapshot || snapshot.revision_or_digest !== expected.revision || snapshot.source_identity !== expected.sourceIdentity)
      blockers.push("source snapshot revision or identity changed after alliance-note preview");
    return [...new Set(blockers)];
  }

  async testConnection(): Promise<Json> {
    return this.track(async () => {
      let config: SourceConfig | undefined;
      try {
        const currentConfig = this.config();
        config = currentConfig;
        if (!currentConfig) throw new Error("WormholeSystems source is not configured");
        const client = this.client(currentConfig);
        const token = this.token(currentConfig);
        const maps = await client.listMaps(this.lifetime.signal);
        this.rejectSecretEcho(maps, token);
        const selected = this.selectedMap(maps, currentConfig);
        if (!selected) {
          await mapDecisionBoundary.run(currentConfig.canonicalMapId, () => this.invalidateActivation(currentConfig!));
          return { status: "inaccessible_or_not_listed", accessible_map_count: maps.length,
            selected_upstream_map_id: currentConfig.upstreamMapId, authenticated: true, live_sync_enabled: false };
        }
        const detail = await client.mapDetail(selected.id, this.lifetime.signal);
        if (containsSecretValue(detail, token)) throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems map response");
        const validated = validateSourceMapDetail(detail, selected.id);
        if (validated.issues.length) throw new WormholeSystemsError(0, 0, `Unsupported WormholeSystems map schema: ${validated.issues.slice(0, 4).map(issue => issue.path).join(", ")}`);
        const mapSystems = validated.detail!.map_solarsystems as Array<Record<string, unknown>>;
        if (!mapSystems.length) throw new WormholeSystemsError(0, 0, "Selected WormholeSystems map has no solar-system records");
        if (mapSystems.length > MAX_SYSTEM_DETAIL_REQUESTS)
          throw new WormholeSystemsError(0, 0, "WormholeSystems map exceeds the bounded system-detail request limit");
        const systemDetails: unknown[] = [];
        let responseBytes = Buffer.byteLength(JSON.stringify(detail), "utf8");
        for (let index = 0; index < mapSystems.length; index++) {
          if (index > 0) await this.sleep(SYSTEM_DETAIL_PACING_MS);
          const systemDetail = await client.solarSystemDetail(String(mapSystems[index].id), this.lifetime.signal);
          if (containsSecretValue(systemDetail, token)) throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems solar-system response");
          responseBytes += Buffer.byteLength(JSON.stringify(systemDetail), "utf8");
          if (responseBytes > MAX_SOURCE_SNAPSHOT_BYTES) throw new WormholeSystemsError(0, 0, "WormholeSystems source snapshot exceeded the size limit");
          systemDetails.push(systemDetail);
        }
        const schemaCheck = normalizeSourceSnapshot({ mapId: selected.id, canonicalMapId: currentConfig.canonicalMapId,
          sourceIdentity: `wormholesystems:${JSON.stringify([currentConfig.origin, selected.id])}`, revisionOrDigest: "schema-test",
          fetchedAt: new Date(this.now()).toISOString(), detail, systemDetails });
        if (!schemaCheck.ok) throw new WormholeSystemsError(0, 0,
          `Unsupported WormholeSystems selected-system schema: ${schemaCheck.issues.slice(0, 5).map(issue => issue.path).join(", ")}`);
        await mapDecisionBoundary.run(currentConfig.canonicalMapId, () => {
          const latest = this.config();
          if (!latest || latest.canonicalMapId !== currentConfig.canonicalMapId || latest.configurationRevision !== currentConfig.configurationRevision ||
              latest.credentialId !== currentConfig.credentialId || latest.origin !== currentConfig.origin || latest.upstreamMapId !== currentConfig.upstreamMapId)
            throw new WormholeSystemsError(0, 0, "WormholeSystems source configuration changed during connection test");
          this.store.db.prepare("UPDATE wormholesystems_credentials SET metadata=json_set(metadata,'$.validation_status','maps_detail_schema_ok','$.last_test_at',?) WHERE id=?")
            .run(this.now(), currentConfig.credentialId);
          this.saveConfig({ ...latest, schemaValidatedAt: this.now(), validatedCredentialId: currentConfig.credentialId,
            validatedApiMapId: selected.id });
        });
        return { status: "maps_detail_schema_ok", authenticated: true, accessible_map_count: maps.length,
          selected_upstream_map_id: selected.id, selected_system_count: mapSystems.length, source_calls: mapSystems.length + 2,
          route_key_mode: currentConfig.mapRouteKey, schema_version: 1,
          live_sync_enabled: currentConfig.liveSyncEnabled, note: "Connection and selected-map schema validated. Explicit operator activation is still required." };
      } catch (error) {
        if (config) await mapDecisionBoundary.run(config.canonicalMapId, () => this.invalidateActivation(config!));
        const failure = safeError(error);
        return { status: failure.status === 401 || failure.status === 403 ? "authentication_failed" : "request_failed",
          status_code: failure.status, error: failure.message, authenticated: false, live_sync_enabled: false };
      }
    });
  }

  enableSync(): Json {
    this.assertNoActiveSync();
    const config = this.config();
    if (!config) throw new Error("WormholeSystems source is not configured");
    if (!config.schemaValidatedAt || config.validatedCredentialId !== config.credentialId || !config.validatedApiMapId)
      throw new Error("A successful connection and selected-map schema test is required before enabling source sync");
    const resolved = this.store.map(config.canonicalMapId);
    if (resolved.id !== config.canonicalMapId || config.upstreamMapId !== opaqueId(config.upstreamMapId, "upstream map ID"))
      throw new Error("WormholeSystems map scope validation failed");
    this.withMapBoundarySync([config.canonicalMapId], () => this.store.db.transaction(() => {
      this.saveConfig({ ...config, configurationRevision: crypto.randomUUID(), canonicalMapId: resolved.id, liveSyncEnabled: true });
      this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(config.canonicalMapId);
    })());
    return this.configuration();
  }

  disableSync(): Json {
    this.assertNoActiveSync();
    const config = this.config();
    if (config) this.withMapBoundarySync([config.canonicalMapId], () => this.store.db.transaction(() => {
      this.saveConfig({ ...config, configurationRevision: crypto.randomUUID(), liveSyncEnabled: false });
      this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(config.canonicalMapId);
    })());
    return this.configuration();
  }

  async listAccessibleMaps(): Promise<Json> {
    return this.track(async () => {
      try {
        const maps = await this.fetchAccessibleMaps();
        return { status: "ok", maps: maps.map(map => ({ id: map.id, slug: map.slug })), live_sync_enabled: this.config()?.liveSyncEnabled ?? false };
      } catch (error) {
        const failure = safeError(error);
        return { status: failure.status === 401 || failure.status === 403 ? "authentication_failed" : "request_failed",
          status_code: failure.status, error: failure.message, maps: [], live_sync_enabled: this.config()?.liveSyncEnabled ?? false };
      }
    });
  }

  async syncMap(canonicalMapId: string): Promise<Json> {
    const mapId = this.canonicalMap(canonicalMapId);
    const config = this.config();
    if (!config || config.canonicalMapId !== mapId) throw new Error("WormholeSystems sync target is not the explicitly configured canonical map");
    this.assertConfigDoesNotContainCredential(config);
    const pending = this.syncs.get(mapId);
    if (pending) return pending;
    const task = this.track(() => this.syncConfiguredMap(mapId, config));
    this.syncs.set(mapId, task);
    try { return await task; }
    finally { if (this.syncs.get(mapId) === task) this.syncs.delete(mapId); }
  }

  private async syncConfiguredMap(mapId: string, config: SourceConfig): Promise<Json> {
    const attemptedAt = this.now();
    const initialPolicy = this.policyState(config).policy ?? { max_age_ms: null, origin: "invalid", revision: null };
    let revisionOrdering: "unknown" | "observed_at" = "unknown";
    const snapshot = this.store.db.prepare("SELECT source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json FROM wormholesystems_source_snapshots WHERE map_id=?").get(mapId) as any;
    const credentialVersion = Number(this.metadata(config.credentialId).credential_version) || 1;
    if (!config.liveSyncEnabled || !config.schemaValidatedAt || config.validatedCredentialId !== config.credentialId || !config.validatedApiMapId) {
      this.store.db.prepare("INSERT INTO wormholesystems_source_runs(map_id,status,attempted_at,error_status,error_message,source_calls) VALUES (?,'disabled',?,0,?,0)")
        .run(mapId, attemptedAt, "Source synchronization has not been operator-enabled after a successful schema test.");
      return { map_id: mapId, status: "disabled", fetched: false, source_calls: 0,
        staleness_policy: initialPolicy,
        stored_snapshot_eligible_for_matching: !!snapshot?.eligible_for_matching,
        source_snapshot_eligible_for_matching: false,
        ...(initialPolicy.origin === "invalid" ? { full_matching_blockers: ["invalid_persisted_policy"] } : {}),
        eligible_for_matching: false, eligible_for_writes: false, nexum_writes_attempted: false,
        last_good_snapshot_retained: !!snapshot, revision_or_digest: snapshot?.revision_or_digest ?? null,
        error: "Source sync is disabled; complete a successful connection test and explicit operator enable action." };
    }
    let sourceCalls = 0;
    try {
      const client = this.client(config);
      const token = this.token(config);
      sourceCalls++;
      const maps = await client.listMaps(this.lifetime.signal);
      this.rejectSecretEcho(maps, token);
      const selected = this.selectedMap(maps, config);
      if (!selected) {
        await mapDecisionBoundary.run(mapId, () => this.store.db.transaction(() => {
          this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(mapId);
          this.store.db.prepare("INSERT INTO wormholesystems_source_runs(map_id,status,attempted_at,error_status,error_message,source_calls) VALUES (?,'inaccessible_or_not_listed',?,404,?,?)")
            .run(mapId, attemptedAt, "Selected upstream map is not in the accessible map list.", sourceCalls);
        })());
        const policy = this.policyState().policy ?? { max_age_ms: null, origin: "invalid", revision: null };
        return { map_id: mapId, status: "inaccessible_or_not_listed", fetched: false, source_calls: 1, staleness_policy: policy,
          stored_snapshot_eligible_for_matching: false, source_snapshot_eligible_for_matching: false,
          ...(policy.origin === "invalid" ? { full_matching_blockers: ["invalid_persisted_policy"] } : {}), eligible_for_matching: false,
          eligible_for_writes: false, nexum_writes_attempted: false, last_good_snapshot_retained: !!snapshot };
      }
      if (selected.id !== config.validatedApiMapId)
        throw new WormholeSystemsError(0, 0, "Configured WormholeSystems map identity changed since validation");
      sourceCalls++;
      const detail = await client.mapDetail(selected.id, this.lifetime.signal);
      if (containsSecretValue(detail, token)) throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems map response");
      const mapValidation = validateSourceMapDetail(detail, selected.id);
      if (mapValidation.issues.length) throw new WormholeSystemsError(0, 0,
        `Unsupported WormholeSystems map schema: ${mapValidation.issues.slice(0, 5).map(issue => issue.path).join(", ")}`);
      const mapSystems = mapValidation.detail!.map_solarsystems as Array<Record<string, unknown>>;
      if (!mapSystems.length) throw new WormholeSystemsError(0, 0, "Selected WormholeSystems map has no solar-system records");
      if (mapSystems.length > MAX_SYSTEM_DETAIL_REQUESTS) throw new WormholeSystemsError(0, 0, "WormholeSystems map exceeds the bounded system-detail request limit");
      let responseBytes = Buffer.byteLength(JSON.stringify(detail), "utf8");
      const systemDetails: unknown[] = [];
      for (let index = 0; index < mapSystems.length; index++) {
        if (index > 0) await this.sleep(SYSTEM_DETAIL_PACING_MS);
        sourceCalls++;
        const systemDetail = await client.solarSystemDetail(String(mapSystems[index].id), this.lifetime.signal);
        if (containsSecretValue(systemDetail, token)) throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems solar-system response");
        responseBytes += Buffer.byteLength(JSON.stringify(systemDetail), "utf8");
        if (responseBytes > MAX_SOURCE_SNAPSHOT_BYTES) throw new WormholeSystemsError(0, 0, "WormholeSystems source snapshot exceeded the size limit");
        systemDetails.push(systemDetail);
      }
      const fetchedAtMs = this.now();
      const fetchedAt = new Date(fetchedAtMs).toISOString();
      const sourceIdentity = `wormholesystems:${JSON.stringify([config.origin, selected.id])}`;
      const revision = crypto.createHash("sha256").update(stableJson({ detail, systemDetails })).digest("hex");
      const normalized = normalizeSourceSnapshot({ mapId: selected.id, canonicalMapId: mapId, sourceIdentity,
        revisionOrDigest: revision, fetchedAt, detail, systemDetails });
      if (!normalized.ok) throw new WormholeSystemsError(0, 0,
        `Unsupported WormholeSystems source schema: ${normalized.issues.slice(0, 5).map(issue => issue.path).join(", ")}`);
      if (snapshot?.observed_at && normalized.fixture.observedAt) {
        revisionOrdering = "observed_at";
        if (Date.parse(normalized.fixture.observedAt) < Date.parse(snapshot.observed_at))
          throw new WormholeSystemsError(0, 0, "WormholeSystems returned an older observed snapshot");
      }
      if (containsSecretValue(normalized.fixture.sourceMetadata, token)) throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems source response");
      const payload = { schema: "wormholesystems-source-v2", adapterVersion: 2, revisionOrdering,
        adapterDiagnostics: normalized.diagnostics, fixture: normalized.fixture };
      const payloadJson = JSON.stringify(payload);
      if (Buffer.byteLength(payloadJson, "utf8") > MAX_SOURCE_SNAPSHOT_BYTES)
        throw new WormholeSystemsError(0, 0, "WormholeSystems normalized snapshot exceeded the size limit");
      await mapDecisionBoundary.run(mapId, () => {
        const currentConfig = this.config();
        const currentCredentialVersion = Number(this.metadata(config.credentialId).credential_version) || 1;
        if (!currentConfig || currentConfig.canonicalMapId !== mapId || currentConfig.origin !== config.origin ||
            currentConfig.upstreamMapId !== config.upstreamMapId || currentConfig.credentialId !== config.credentialId ||
            currentConfig.configuredAt !== config.configuredAt || currentConfig.configurationRevision !== config.configurationRevision || !currentConfig.liveSyncEnabled ||
            !currentConfig.schemaValidatedAt || currentConfig.validatedCredentialId !== currentConfig.credentialId ||
            currentCredentialVersion !== credentialVersion)
          throw new WormholeSystemsError(0, 0, "WormholeSystems source configuration changed during snapshot fetch");
        this.store.db.transaction(() => {
        this.store.db.prepare(`INSERT INTO wormholesystems_source_snapshots(map_id,source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json,eligible_for_matching,credential_id,credential_version,source_configured_at,source_config_revision)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(map_id) DO UPDATE SET source_identity=excluded.source_identity,
          source_origin=excluded.source_origin,source_api_map_id=excluded.source_api_map_id,revision_or_digest=excluded.revision_or_digest,
          fetched_at=excluded.fetched_at,observed_at=excluded.observed_at,payload_json=excluded.payload_json,eligible_for_matching=excluded.eligible_for_matching,
          credential_id=excluded.credential_id,credential_version=excluded.credential_version,source_configured_at=excluded.source_configured_at,
          source_config_revision=excluded.source_config_revision`)
          .run(mapId, sourceIdentity, config.origin, selected.id, revision, fetchedAt,
             normalized.fixture.observedAt, payloadJson, 1, config.credentialId, credentialVersion, config.configuredAt,
            config.configurationRevision);
          this.store.db.prepare("INSERT INTO wormholesystems_source_runs(map_id,status,attempted_at,succeeded_at,revision_or_digest,error_status,error_message,source_calls,revision_ordering) VALUES (?,'snapshot_validated',?,?,?,0,NULL,?,?)")
            .run(mapId, attemptedAt, fetchedAtMs, revision, sourceCalls, revisionOrdering);
         })();
      });
      const finalStatus = await mapDecisionBoundary.run(mapId, () => this.statusLocked(mapId) as Json);
      return { map_id: mapId, status: "snapshot_validated", fetched: true, source_calls: sourceCalls,
        source_identity: sourceIdentity, source_api_map_id: selected.id, revision_or_digest: revision, revision_ordering: revisionOrdering,
        fetched_at: fetchedAt, observed_at: normalized.fixture.observedAt, snapshot_stored: true,
        ...normalized.diagnostics, staleness_policy: finalStatus.staleness_policy,
        source_snapshot_blockers: finalStatus.source_snapshot_blockers ?? [],
        nexum_writes_attempted: false, data_writes_enabled: false, fetch_only: true,
        note: "Validated source snapshot stored locally. This fetch-only sync performs no Nexum data or note writes; inspect the stored evidence with local preview." };
    } catch (error) {
      const failure = safeError(error);
      const policy = this.policyState().policy ?? { max_age_ms: null, origin: "invalid", revision: null };
      await mapDecisionBoundary.run(mapId, () => this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(mapId);
        this.store.db.prepare("INSERT INTO wormholesystems_source_runs(map_id,status,attempted_at,error_status,error_message,source_calls,revision_ordering) VALUES (?,'fetch_failed',?,?,?,?,?)")
          .run(mapId, attemptedAt, failure.status, failure.message, sourceCalls, revisionOrdering);
      })());
      return { map_id: mapId, status: "fetch_failed", fetched: false, source_calls: sourceCalls,
        staleness_policy: policy,
        stored_snapshot_eligible_for_matching: false, source_snapshot_eligible_for_matching: false,
        ...(policy.origin === "invalid" ? { full_matching_blockers: ["invalid_persisted_policy"] } : {}),
        eligible_for_matching: false, eligible_for_writes: false, nexum_writes_attempted: false,
        last_good_snapshot_retained: !!snapshot, last_good_revision_or_digest: snapshot?.revision_or_digest ?? null,
        error_status: failure.status, error: failure.message };
    }
  }

  private statusBase(mapId: string): Json {
    const snapshot = this.store.db.prepare("SELECT * FROM wormholesystems_source_snapshots WHERE map_id=?").get(mapId) as any;
    const run = this.store.db.prepare("SELECT status,attempted_at,succeeded_at,revision_or_digest,error_status,error_message,source_calls,revision_ordering,write_outcomes_json FROM wormholesystems_source_runs WHERE map_id=? ORDER BY id DESC LIMIT 1").get(mapId) as any;
    const config = this.config();
    if (config) this.assertConfigDoesNotContainCredential(config);
    let payload: Json | undefined;
    if (snapshot) try { payload = JSON.parse(snapshot.payload_json) as Json; } catch { payload = undefined; }
    const fixture = payload?.fixture as Json | undefined;
    const adapterDiagnostics = payload?.adapterDiagnostics as Json | undefined;
    const sourceMetadata = fixture?.sourceMetadata as Json | undefined;
    const sourceMap = sourceMetadata?.map as Json | undefined;
    const policyState = this.policyState(config);
    const sourceBlockers = snapshot ? this.snapshotBlockers(mapId, snapshot) : ["no source snapshot is stored"];
    if (!policyState.valid && !sourceBlockers.includes("invalid_persisted_policy")) sourceBlockers.push("invalid_persisted_policy");
    const storedEligible = !!snapshot?.eligible_for_matching;
    const sourceEligible = !!snapshot && sourceBlockers.length === 0;
    return { map_id: mapId, configured: config?.canonicalMapId === mapId,
       integration_mode: config?.liveSyncEnabled ? "operator_enabled_source_sync" : "source_sync_disabled",
       live_sync_enabled: !!config?.liveSyncEnabled,
       connection_test_validated: !!(config?.schemaValidatedAt && config.validatedCredentialId === config.credentialId),
       snapshot_present: !!snapshot, ...(snapshot ? { source_identity: snapshot.source_identity, source_origin: snapshot.source_origin,
           source_api_map_id: snapshot.source_api_map_id, revision_or_digest: snapshot.revision_or_digest,
           revision_ordering: payload?.revisionOrdering ?? "unknown",
           fetched_at: snapshot.fetched_at, fetched_age_ms: this.now() - Date.parse(snapshot.fetched_at),
           observed_at: snapshot.observed_at, observed_age_ms: snapshot.observed_at ? this.now() - Date.parse(snapshot.observed_at) : null,
             eligible_for_matching: false, stored_snapshot_eligible_for_matching: storedEligible,
             source_snapshot_eligible_for_matching: sourceEligible, source_snapshot_blockers: sourceBlockers,
             matching_blockers: sourceBlockers,
           adapter_version: payload?.adapterVersion ?? null, system_count: fixture?.systems?.length ?? 0,
           signature_count: fixture?.signatures?.length ?? 0, connection_count: fixture?.connections?.length ?? 0,
           opaque_map_connection_count: adapterDiagnostics?.opaqueMapConnectionCount ?? null,
           unmapped_map_connection_count: adapterDiagnostics?.unmappedMapConnectionCount ?? null,
           audit_record_count: adapterDiagnostics?.auditRecordCount ?? null,
           source_map_field_names: sourceMap ? Object.keys(sourceMap).sort() : [],
           source_freshness_evidence: { system_observations: ((fixture?.systems ?? []) as Json[]).filter(system => !!system.observedAt).length,
             signature_observations: ((fixture?.signatures ?? []) as Json[]).filter(signature => !!signature.observedAt).length,
             signature_freshness_deadlines: ((fixture?.signatures ?? []) as Json[]).filter(signature => !!signature.freshUntil).length,
              connection_observations: ((fixture?.connections ?? []) as Json[]).filter(connection => !!connection.observedAt).length,
              connection_freshness_deadlines: ((fixture?.connections ?? []) as Json[]).filter(connection => !!connection.freshUntil).length } } : {
                eligible_for_matching: false, stored_snapshot_eligible_for_matching: false,
                source_snapshot_eligible_for_matching: false, source_snapshot_blockers: sourceBlockers, matching_blockers: sourceBlockers }),
         staleness_policy: policyState.policy ?? { max_age_ms: null, origin: "invalid", revision: null },
         eligible_for_writes: false, last_attempt: run ? { status: run.status, attempted_at: run.attempted_at,
           succeeded_at: run.succeeded_at, source_calls: run.source_calls, revision_or_digest: run.revision_or_digest,
           revision_ordering: run.revision_ordering,
           error_status: run.error_status, error: run.error_message,
           write_outcomes: run.write_outcomes_json ? JSON.parse(run.write_outcomes_json) : null } : null,
        preview: { local_only: true, upstream_calls: 0, authority_dependent_bookmark_notes: "blocked_unknown_source_aliases_or_status_annotations", writes_enabled: false } };
  }

  private statusLocked(mapId: string): Json {
    const current = this.statusBase(mapId);
    const checked = this.previewLocked(mapId, current) as any;
    const preview = checked.preview ?? {};
    const topology = preview.topology_apply ?? { eligible: false, blockers: current.matching_blockers ?? ["no source snapshot is stored"] };
    const allianceNotes = (preview.alliance_notes ?? []) as Array<Record<string, any>>;
    const renderedEligibleCount = allianceNotes.filter(note => note.eligible_for_write).length;
    const pendingNotes = allianceNotes.filter(note => note.eligible_for_write && note.pending);
    const topologyEligible = topology.eligible === true;
    const allianceNotesEligible = pendingNotes.length > 0;
    const eligibleForWrites = topologyEligible || allianceNotesEligible;
    const noteDiagnostics = allianceNotes.map(note => ({ source_connection_id: note.source_connection_id,
      source_signature_key: note.source_signature_key, system_id: note.system_id, signature_id: note.signature_id,
      eligible: note.eligible_for_write === true, pending: note.pending === true,
      blocking_fields: note.blocking_fields ?? [] }));
    const previewFullEligible = preview.full_matching_eligible === true;
    const fullBlockers = Array.isArray(preview.full_matching_blockers) ? preview.full_matching_blockers : current.source_snapshot_blockers ?? [];
    return { ...current, eligible_for_matching: previewFullEligible,
      matching_blockers: fullBlockers,
      full_matching_blockers: fullBlockers,
      nexum_matching_blockers: preview.nexum_cache?.matching_evidence_blockers ?? [],
      source_snapshot_eligible_for_matching: preview.source_snapshot_eligible_for_matching === true,
      eligible_for_topology_write: topologyEligible,
      eligible_for_alliance_note_writes: allianceNotesEligible, eligible_for_writes: eligibleForWrites,
      write_eligibility: { topology: { eligible: topologyEligible, blockers: topology.blockers ?? [] },
        alliance_notes: { eligible: allianceNotesEligible, rendered_eligible_count: renderedEligibleCount,
         pending_count: pendingNotes.length, notes: noteDiagnostics,
          blockers: allianceNotesEligible ? [] : [...new Set(allianceNotes.flatMap(note => note.blocking_fields ?? []))] } },
        preview: { ...current.preview, topology_eligible: topologyEligible, alliance_note_eligible: allianceNotesEligible,
          writes_enabled: false, authority_dependent_bookmark_notes: "explicit linked-note operation required; status and preview do not write notes",
         data_write_gate: "not_implemented_in_diagnostic_milestone" } };
  }

  status(canonicalMapId: string): Json {
    const mapId = this.canonicalMap(canonicalMapId);
    const locked = mapDecisionBoundary.runSync(mapId, () => this.statusLocked(mapId));
    if (locked.acquired) return locked.value;
    const current = this.statusBase(mapId);
    const reason = "Nexum map decision boundary is busy; status eligibility is unavailable until state is coherent";
    return { ...current, eligible_for_matching: false, source_snapshot_eligible_for_matching: false,
      matching_blockers: [reason], full_matching_blockers: [reason], nexum_matching_blockers: [reason],
      source_snapshot_blockers: [reason], status_blockers: [reason], eligible_for_topology_write: false,
      eligible_for_alliance_note_writes: false, eligible_for_writes: false,
       write_eligibility: { topology: { eligible: false, blockers: [reason] }, alliance_notes: { eligible: false, blockers: [reason], notes: [] } } };
  }

  async reconcileLinkedNotes(canonicalMapId: string): Promise<Json> {
    const mapId = this.canonicalMap(canonicalMapId);
    return this.track(async () => {
      const planned = mapDecisionBoundary.runSync(mapId, () => {
        const config = this.config();
        const targetMap = this.store.map(mapId);
        return { config, targetMapId: targetMap.nexum_map_id, preview: this.previewLocked(mapId, undefined, true) as any };
      });
      if (!planned.acquired) return { map_id: mapId, status: "blocked", attempted_direction_count: 0,
        blockers: ["Nexum map decision boundary is busy; linked-note reconciliation was not started"] };

      const { config, targetMapId, preview } = planned.value;
      const noteRows = (preview.preview?.alliance_notes ?? []) as Array<Record<string, any>>;
      const eligible = noteRows.filter(note => note.eligible_for_write === true);
      const changes = eligible.filter(note => note.pending === true && typeof note.system_id === "string" &&
        typeof note.signature_id === "string" && typeof note.desired_note === "string" && note.expected_identity)
        .map(note => ({ systemId: note.system_id as string, signatureId: note.signature_id as string,
          notes: note.desired_note as string, expectedIdentity: note.expected_identity as WormholesystemsSignatureNoteIdentity }));
      if (!changes.length) {
        const blockers = [...new Set([
          ...noteRows.flatMap(note => Array.isArray(note.blocking_fields) ? note.blocking_fields : []),
          ...(!noteRows.length ? preview.source_snapshot_blockers ?? [] : []),
        ])].filter((item): item is string => typeof item === "string").slice(0, 20);
        return { map_id: mapId, status: eligible.length ? "unchanged" : "blocked",
          eligible_direction_count: eligible.length, attempted_direction_count: 0, written_count: 0,
          outcomes: [], blockers: eligible.length ? [] : blockers.length ? blockers : ["No linked note direction is currently eligible for PATCH"] };
      }
      if (!config || config.canonicalMapId !== mapId || typeof preview.preview?.source_revision !== "string" ||
          typeof preview.preview?.source_snapshot?.source_identity !== "string" || typeof preview.staleness_policy?.revision !== "string")
        return { map_id: mapId, status: "blocked", eligible_direction_count: eligible.length,
          attempted_direction_count: 0, written_count: 0, outcomes: [],
          blockers: ["Current source identity, configuration or freshness policy is unavailable"] };

      const expected = { revision: preview.preview.source_revision as string,
        sourceIdentity: preview.preview.source_snapshot.source_identity as string,
        configurationRevision: config.configurationRevision, policyRevision: preview.staleness_policy.revision as string,
        nexumMapId: String(targetMapId) };
      try {
        const writer = this.nexumWrites ?? getNexum();
        const writeResult = await writer.writeWormholesystemsSignatureNotes(mapId, changes,
          () => this.allianceNoteSourceBlockers(mapId, expected)) as any;
        const items = Array.isArray(writeResult?.items) ? writeResult.items : [];
        const outcomes = items.slice(0, 500).map((item: any, item_index: number) => ({
          item_index: Number.isSafeInteger(item?.item_index) ? item.item_index : item_index,
          status: ["written", "unchanged", "blocked", "failed", "not_attempted"].includes(item?.status) ? item.status : "unknown",
        }));
        const blockers = Array.isArray(writeResult?.blockers) ? writeResult.blockers.filter((item: unknown): item is string =>
          typeof item === "string").slice(0, 20) : [];
        return { map_id: mapId, status: ["blocked", "unchanged", "completed", "failed"].includes(writeResult?.status)
            ? writeResult.status : "unknown",
          eligible_direction_count: eligible.length, attempted_direction_count: changes.length,
          written_count: Number.isSafeInteger(writeResult?.written) && writeResult.written >= 0 ? writeResult.written : 0,
          outcomes, outcomes_total: items.length, outcomes_omitted: Math.max(0, items.length - outcomes.length),
          ...(blockers.length ? { blockers } : {}) };
      } catch {
        return { map_id: mapId, status: "failed", eligible_direction_count: eligible.length,
          attempted_direction_count: changes.length, written_count: 0, outcomes: [],
          error: "Nexum linked-note reconciliation failed; details omitted" };
      }
    });
  }

  preview(canonicalMapId: string): Json {
    const mapId = this.canonicalMap(canonicalMapId);
    const locked = mapDecisionBoundary.runSync(mapId, () => this.previewLocked(mapId));
    if (!locked.acquired) {
      const current = this.status(mapId) as Json;
      const reason = "Nexum map decision boundary is busy; preview is blocked until a coherent state is available";
      return { ...current, eligible_for_matching: false, source_snapshot_eligible_for_matching: false,
        eligible_for_topology_write: false, eligible_for_alliance_note_writes: false, eligible_for_writes: false,
        full_matching_blockers: [reason], nexum_matching_blockers: [reason], source_snapshot_blockers: [reason],
        write_eligibility: { topology: { eligible: false, blockers: [reason] }, alliance_notes: { eligible: false, blockers: [reason], notes: [] } },
        preview: { local_only: true, upstream_calls: 0, matching_performed: false,
          source_snapshot_eligible_for_matching: false, full_matching_eligible: false, full_matching_blockers: [reason],
          matched: [], unmatched: [], conflicts: [{ reason }], final_names: "blocked_unknown_source_aliases_or_status_annotations",
          writes_enabled: false, nexum_writes_attempted: false } };
    }
    return locked.value;
  }

  private previewLocked(mapId: string, status?: Json, includeNoteWriteDetails = false): Json {
    const current = status ?? this.statusBase(mapId);
    const row = this.store.db.prepare("SELECT * FROM wormholesystems_source_snapshots WHERE map_id=?").get(mapId) as any;
    if (!row) return { ...current, eligible_for_matching: false, source_snapshot_eligible_for_matching: false,
      source_snapshot_blockers: current.source_snapshot_blockers ?? ["no source snapshot is stored"],
      full_matching_blockers: current.source_snapshot_blockers ?? ["no source snapshot is stored"],
      nexum_matching_blockers: [], preview: { local_only: true, upstream_calls: 0, matching_performed: false,
       stored_snapshot_eligible_for_matching: false, source_snapshot_eligible_for_matching: false,
       full_matching_eligible: false, full_matching_blockers: current.source_snapshot_blockers ?? ["no source snapshot is stored"],
        matched: [], unmatched: [], conflicts: [], alliance_notes: [],
        source_signature_classification: { status: "unavailable", total: 0, omitted: 0, signatures: [] },
        topology_apply: { eligible: false, blockers: ["no source snapshot is stored", "data writes are not implemented in this diagnostic milestone"] },
        final_names: "blocked_unknown_source_aliases_or_status_annotations", writes_enabled: false, nexum_writes_attempted: false } };
      let payload: Json | undefined;
      try { payload = JSON.parse(row.payload_json) as Json; } catch { payload = undefined; }
      const supportedSnapshotVersion = (payload?.schema === "wormholesystems-source-v1" && payload?.adapterVersion === 1 && payload.fixture?.schemaVersion === 1) ||
        (payload?.schema === "wormholesystems-source-v2" && payload?.adapterVersion === 2 && payload.fixture?.schemaVersion === 2);
      if (!payload || !supportedSnapshotVersion || !payload.fixture || payload.fixture.sourceKind !== "wormholesystems") {
        const reason = "stored snapshot does not match the validated adapter version";
       return { ...current, eligible_for_matching: false, source_snapshot_eligible_for_matching: false,
         source_snapshot_blockers: [reason], matching_blockers: [reason], preview: { local_only: true, upstream_calls: 0,
           matching_performed: false, stored_snapshot_eligible_for_matching: !!row.eligible_for_matching,
           source_snapshot_eligible_for_matching: false, full_matching_eligible: false,
            full_matching_blockers: [reason], matched: [], unmatched: [], conflicts: [{ reason }],
            source_signature_classification: { status: "unavailable", total: 0, omitted: 0, signatures: [] },
            final_names: "blocked_unknown_source_aliases_or_status_annotations", writes_enabled: false } };
      }
      const validatedFixture = validateWormholeSystemsFixture(payload.fixture);
      if (!validatedFixture.ok) {
        const reason = "stored source snapshot failed canonical fixture validation";
        return { ...current, eligible_for_matching: false, source_snapshot_eligible_for_matching: false,
          source_snapshot_blockers: [reason], matching_blockers: [reason], preview: { local_only: true, upstream_calls: 0,
            matching_performed: false, stored_snapshot_eligible_for_matching: !!row.eligible_for_matching,
            source_snapshot_eligible_for_matching: false, full_matching_eligible: false, full_matching_blockers: [reason],
            source_signature_classification: { status: "unavailable", total: 0, omitted: 0, signatures: [] },
            matched: [], unmatched: [], conflicts: [{ reason }], writes_enabled: false, nexum_writes_attempted: false } };
      }
      const sourceFixture = validatedFixture.value;
      const source = sourceFixture as unknown as Json;
      const classificationCaptured = sourceFixture.schemaVersion === 2 && Array.isArray(sourceFixture.sourceSignatureEvidence);
      const classificationRows: ValidatedSourceSignatureEvidence[] = classificationCaptured
        ? sourceFixture.sourceSignatureEvidence!
        : sourceFixture.signatures.filter(signature => signature.sourceSignatureId !== null).map(signature => ({
            sourceSignatureId: signature.sourceSignatureId!, scannerEveSystemId: signature.scannerEveSystemId,
            signatureCode: signature.signatureCode,
          }));
      const signatureEvidenceCap = 500;
      const sourceSignatureEvidence = classificationRows.slice(0, signatureEvidenceCap).map(signature => ({
        source_signature_id: signature.sourceSignatureId,
        ...(Object.prototype.hasOwnProperty.call(signature, "signatureCode") ? { signature_code: signature.signatureCode } : {}),
        scanner_eve_system_id: signature.scannerEveSystemId,
        classification_status: classificationCaptured ? "captured" : "not_captured_in_snapshot",
        ...(classificationCaptured && Object.prototype.hasOwnProperty.call(signature, "signatureTypeId") ? { signature_type_id: signature.signatureTypeId } : {}),
        ...(classificationCaptured && Object.prototype.hasOwnProperty.call(signature, "signatureCategoryId") ? { signature_category_id: signature.signatureCategoryId } : {}),
        ...(classificationCaptured && Object.prototype.hasOwnProperty.call(signature, "wormholeId") ? { wormhole_id: signature.wormholeId } : {}),
        ...(classificationCaptured && Object.prototype.hasOwnProperty.call(signature, "nestedWormholeId") ? { nested_wormhole_id: signature.nestedWormholeId } : {}),
        ...(classificationCaptured && Object.prototype.hasOwnProperty.call(signature, "wormholeName") ? { wormhole_name: signature.wormholeName } : {}),
      }));
      const classificationStatus = classificationCaptured ? "captured" : "not_captured_in_snapshot";
    const state = this.store.state(mapId) as Json;
    const nexumMap = this.store.map(mapId);
    const policyState = this.policyState();
    const policy = policyState.policy;
    const maxStalenessMs = policy?.max_age_ms;
    const snapshotReasons = this.snapshotBlockers(mapId, row);
    const mapFetchedAt = nexumMap.hydrated_at === null || nexumMap.hydrated_at === undefined ? NaN : Number(nexumMap.hydrated_at);
    const mapCacheFresh = maxStalenessMs !== undefined && Number.isFinite(mapFetchedAt) && mapFetchedAt <= this.now() &&
      this.now() - mapFetchedAt <= maxStalenessMs;
    const sourceSystems = new Map<number, Json[]>([]);
    for (const system of (source.systems ?? []) as Json[]) sourceSystems.set(system.eveSolarSystemId, [...(sourceSystems.get(system.eveSolarSystemId) ?? []), system]);
    const nexumSystems = (state.systems ?? []) as Json[];
    const nexumSignatures: Json[] = [];
    const resourceFetchTimes: number[] = [];
    const signatureResources = new Map<string, { fetchedAt: number }>();
    for (const system of nexumSystems) {
      const resource = this.store.resources(mapId, String(system.id));
      if (Number.isFinite(resource.signatures?.fetched_at)) resourceFetchTimes.push(Number(resource.signatures.fetched_at));
      signatureResources.set(String(system.id), { fetchedAt: resource.signatures?.fetched_at === null || resource.signatures?.fetched_at === undefined
        ? NaN : Number(resource.signatures.fetched_at) });
      for (const signature of (resource.signatures?.items ?? []) as Json[])
        nexumSignatures.push({ ...signature, _systemId: String(system.id), _resourceFetchedAt: resource.signatures?.fetched_at ?? null });
    }
    const nexumEvidenceBlockers: string[] = [];
    if (!policy) nexumEvidenceBlockers.push("invalid_persisted_policy");
    if (nexumMap.health !== "live" || !mapCacheFresh)
      nexumEvidenceBlockers.push("Nexum map cache is not live or exceeds the configured maximum staleness");
    for (const sourceSystem of (source.systems ?? []) as Json[]) {
      const identities = nexumSystems.filter(system => Number(system.eveSystemId) === Number(sourceSystem.eveSolarSystemId));
      if (identities.length !== 1) {
        nexumEvidenceBlockers.push("required Nexum system identity is missing or ambiguous");
        continue;
      }
      const resource = signatureResources.get(String(identities[0].id));
      if (!resource || !Number.isFinite(resource.fetchedAt) || resource.fetchedAt > this.now() || maxStalenessMs === undefined ||
          this.now() - resource.fetchedAt > maxStalenessMs)
        nexumEvidenceBlockers.push("Nexum signature cache is missing, future-dated or exceeds the configured maximum staleness");
    }
    const uniqueNexumEvidenceBlockers = [...new Set([...nexumEvidenceBlockers,
      ...this.targetCacheBlockers(mapId, (source.systems ?? []) as Json[], maxStalenessMs)])];
    const matched: Json[] = [], unmatched: Json[] = [], conflicts: Json[] = [];
    const signatures = new Map<string, Json>(((source.signatures ?? []) as Json[]).map(signature => [signature.signatureKey, signature]));
    const pushIssue = (target: Json[], connection: Json, reason: string, keys: (string | null)[] = []) => {
      target.push({ source_connection_id: connection.sourceConnectionId, source_signature_keys: keys, reason });
    };
    const edges = (state.connections ?? []) as Json[];
    for (const connection of (source.connections ?? []) as Json[]) {
      const from = connection.fromSignatureKey ? signatures.get(connection.fromSignatureKey) : undefined;
      const to = connection.toSignatureKey ? signatures.get(connection.toSignatureKey) : undefined;
      const keys = [connection.fromSignatureKey ?? null, connection.toSignatureKey ?? null];
      if (!from || !to) { pushIssue(unmatched, connection, "both directional source signatures are required for exact identity matching", keys); continue; }
      const sourceFrom = sourceSystems.get(connection.fromEveSystemId) ?? [];
      const sourceTo = sourceSystems.get(connection.toEveSystemId) ?? [];
      const fromSystems = nexumSystems.filter(system => Number(system.eveSystemId) === connection.fromEveSystemId);
      const toSystems = nexumSystems.filter(system => Number(system.eveSystemId) === connection.toEveSystemId);
      if (sourceFrom.length !== 1 || sourceTo.length !== 1 || fromSystems.length !== 1 || toSystems.length !== 1) {
        pushIssue(conflicts, connection, "source or Nexum EVE-system identity is missing or ambiguous", keys); continue;
      }
      const fromSystem = fromSystems[0], toSystem = toSystems[0];
      const candidates: Json[] = [];
      for (const edge of edges) {
        const forward = String(edge.sourceId) === String(fromSystem.id) && String(edge.targetId) === String(toSystem.id);
        const reverse = String(edge.sourceId) === String(toSystem.id) && String(edge.targetId) === String(fromSystem.id);
        if (!forward && !reverse) continue;
        const fromRowId = forward ? edge.sourceSignatureId : edge.targetSignatureId;
        const toRowId = forward ? edge.targetSignatureId : edge.sourceSignatureId;
        const fromRows = nexumSignatures.filter(row => String(row._systemId) === String(fromSystem.id) && String(row.id) === String(fromRowId));
        const toRows = nexumSignatures.filter(row => String(row._systemId) === String(toSystem.id) && String(row.id) === String(toRowId));
        if (fromRows.length !== 1 || toRows.length !== 1 || fromRows[0].signature !== from.signatureCode || toRows[0].signature !== to.signatureCode) continue;
        candidates.push({ edge, fromRow: fromRows[0], toRow: toRows[0] });
      }
      if (!candidates.length) { pushIssue(unmatched, connection, "no exact cached Nexum connection and directional signature match", keys); continue; }
      if (candidates.length !== 1) { pushIssue(conflicts, connection, "multiple cached Nexum connections match source identities", keys); continue; }
      const candidate = candidates[0];
      const resourceFresh = maxStalenessMs !== undefined && [candidate.fromRow, candidate.toRow].every(row => Number.isFinite(row._resourceFetchedAt) &&
        row._resourceFetchedAt <= this.now() && this.now() - row._resourceFetchedAt <= maxStalenessMs);
      const nexumBroken = candidate.edge.broken === true || ["broken", "expired"].includes(String(candidate.edge.timeStatus ?? "").toLowerCase());
      const nexumStateKnown = candidate.edge.broken === false && typeof candidate.edge.timeStatus === "string" &&
        !!candidate.edge.timeStatus && !["unknown", "unavailable"].includes(candidate.edge.timeStatus.toLowerCase()) &&
        candidate.fromRow.status === "active" && candidate.toRow.status === "active";
      const reasons = [...snapshotReasons, ...uniqueNexumEvidenceBlockers, !resourceFresh && "Nexum signature cache is missing, future-dated or exceeds the configured maximum staleness",
        !nexumStateKnown && "Nexum connection or signature status is unknown", nexumBroken && "Nexum connection is broken or expired"].filter(Boolean);
      matched.push({ source_connection_id: connection.sourceConnectionId, source_signature_keys: keys,
        nexum_connection_id: candidate.edge.id, nexum_signature_row_ids: [candidate.fromRow.id, candidate.toRow.id],
        status: reasons.length ? "identity_match_conflicted" : "identity_match_only", identity_match_complete: reasons.length === 0,
         eligible_for_reconciliation: false, blocking_reasons: [...reasons, SOURCE_WRITE_BLOCKER],
        proposed_name: null, action: "none" });
      if (reasons.length) pushIssue(conflicts, connection, reasons.join("; "), keys);
    }
    const allSourceConnectionIds = new Set(((source.connections ?? []) as Json[]).map(connection => connection.sourceConnectionId));
    const emittedUnconnectedIds = new Set<string>();
    for (const signature of (source.signatures ?? []) as Json[]) {
      if (signature.sourceConnectionId && allSourceConnectionIds.has(signature.sourceConnectionId)) continue;
      const sourceSignatureId = typeof signature.sourceSignatureId === "string" ? signature.sourceSignatureId : "";
      if (sourceSignatureId && emittedUnconnectedIds.has(sourceSignatureId)) continue;
      if (sourceSignatureId) emittedUnconnectedIds.add(sourceSignatureId);
      unmatched.push({ source_signature_id: sourceSignatureId || null,
        scanner_eve_system_id: Number.isSafeInteger(signature.scannerEveSystemId) ? signature.scannerEveSystemId : null,
        ...(typeof signature.signatureCode === "string" && signature.signatureCode ? { signature_code: signature.signatureCode } : {}),
        reason: "no_source_connection_reference" });
    }
    const allianceNotes: Json[] = [];
    const nexumSignatureById = new Map(nexumSignatures.map(signature => [String(signature.id), signature]));
    const noteEvidence = sourceFixture.allianceNoteEvidence;
    const aliasesBySourceId = new Map((noteEvidence?.systems ?? []).map(system => [system.sourceSystemId, system]));
    const noteConnectionsBySourceId = new Map((noteEvidence?.connections ?? []).map(connection => [connection.sourceConnectionId, connection]));
    const signatureAnnotationsBySourceId = new Map((noteEvidence?.signatures ?? []).map(signature => [signature.sourceSignatureId, signature.statusAnnotation]));
    const knownStatusAnnotations = new Set(noteEvidence?.knownStatusAnnotations ?? []);
    const notePlans: Array<{ connection: Json; direction: { key: string | null; from: any; to: any; reverse: boolean };
      signature?: Json; targetRow?: Json; edge?: Json; expectedIdentity?: WormholesystemsSignatureNoteIdentity;
      identityMatched: boolean; directionBlockers: string[] }> = [];
    for (const connection of (source.connections ?? []) as Json[]) {
      const fromSystem = ((source.systems ?? []) as Json[]).find(system => system.eveSolarSystemId === connection.fromEveSystemId) as any;
      const toSystem = ((source.systems ?? []) as Json[]).find(system => system.eveSolarSystemId === connection.toEveSystemId) as any;
      for (const direction of [
        { key: connection.fromSignatureKey as string | null, from: fromSystem, to: toSystem, reverse: false },
        { key: connection.toSignatureKey as string | null, from: toSystem, to: fromSystem, reverse: true },
      ]) {
        const signature = direction.key ? signatures.get(String(direction.key)) as Json | undefined : undefined;
        const directionBlockers: string[] = [];
        let targetRow: Json | undefined, targetEdge: Json | undefined;
        if (!direction.key || !signature) directionBlockers.push("directional signature: source connection has no unique linked signature for this endpoint");
        const fromSourceRows = ((source.systems ?? []) as Json[]).filter(system => system.eveSolarSystemId === direction.from?.eveSolarSystemId);
        const toSourceRows = ((source.systems ?? []) as Json[]).filter(system => system.eveSolarSystemId === direction.to?.eveSolarSystemId);
        const fromNexumSystems = nexumSystems.filter(system => Number(system.eveSystemId) === direction.from?.eveSolarSystemId);
        const toNexumSystems = nexumSystems.filter(system => Number(system.eveSystemId) === direction.to?.eveSolarSystemId);
        if (fromSourceRows.length !== 1 || toSourceRows.length !== 1 || fromNexumSystems.length !== 1 || toNexumSystems.length !== 1)
          directionBlockers.push("source or Nexum EVE-system identity is missing or ambiguous");
        const directionalCandidates: Array<{ edge: Json; row: Json; fromSystem: Json; toSystem: Json }> = [];
        if (signature && fromSourceRows.length === 1 && toSourceRows.length === 1 && fromNexumSystems.length === 1 && toNexumSystems.length === 1) {
          const fromNexum = fromNexumSystems[0], toNexum = toNexumSystems[0];
          for (const edge of edges) {
            const forward = String(edge.sourceId) === String(fromNexum.id) && String(edge.targetId) === String(toNexum.id);
            const reverse = String(edge.sourceId) === String(toNexum.id) && String(edge.targetId) === String(fromNexum.id);
            if (!forward && !reverse) continue;
            const rowId = forward ? edge.sourceSignatureId : edge.targetSignatureId;
            const rows = nexumSignatures.filter(candidate => String(candidate._systemId) === String(fromNexum.id) &&
              String(candidate.id) === String(rowId) && candidate.signature === signature.signatureCode);
            if (rows.length === 1) directionalCandidates.push({ edge, row: rows[0], fromSystem: fromNexum, toSystem: toNexum });
          }
        }
        let expectedIdentity: WormholesystemsSignatureNoteIdentity | undefined;
        if (directionalCandidates.length === 1) {
          targetRow = directionalCandidates[0].row;
          targetEdge = directionalCandidates[0].edge;
          if (policy && maxStalenessMs !== undefined) expectedIdentity = { connectionId: String(targetEdge.id),
            fromSystemId: String(directionalCandidates[0].fromSystem.id), toSystemId: String(directionalCandidates[0].toSystem.id),
            fromEveSystemId: Number(direction.from.eveSolarSystemId), toEveSystemId: Number(direction.to.eveSolarSystemId),
            signatureCode: String(signature!.signatureCode), maxStalenessMs, stalenessPolicyRevision: policy.revision };
        } else if (directionalCandidates.length > 1) directionBlockers.push("multiple Nexum connections match this directional signature identity");
        else if (signature && !directionBlockers.length) directionBlockers.push("no exact cached Nexum connection and directional signature match");
        if (targetRow) {
          const resourceFresh = Number.isFinite(targetRow._resourceFetchedAt) && targetRow._resourceFetchedAt <= this.now() &&
            maxStalenessMs !== undefined && this.now() - targetRow._resourceFetchedAt <= maxStalenessMs;
          const nexumStateKnown = targetEdge?.broken === false && typeof targetEdge?.timeStatus === "string" &&
            !!targetEdge.timeStatus && !["unknown", "unavailable"].includes(targetEdge.timeStatus.toLowerCase()) && targetRow.status === "active";
          const nexumBroken = targetEdge?.broken === true || ["broken", "expired"].includes(String(targetEdge?.timeStatus ?? "").toLowerCase());
          if (!resourceFresh) directionBlockers.push("Nexum signature cache is missing, future-dated or exceeds the configured maximum staleness");
          if (!mapCacheFresh || nexumMap.health !== "live") directionBlockers.push("Nexum map cache is not live or exceeds the configured maximum staleness");
          if (!nexumStateKnown) directionBlockers.push("Nexum connection or signature status is unknown");
          if (nexumBroken) directionBlockers.push("Nexum connection is broken or expired");
        }
        notePlans.push({ connection, direction, signature, targetRow, edge: targetEdge,
          expectedIdentity,
          identityMatched: !!targetRow && directionBlockers.length === 0, directionBlockers });
      }
    }
    const sourcesByTargetEdge = new Map<string, Set<string>>();
    for (const plan of notePlans) if (plan.edge) {
      const edgeId = String(plan.edge.id);
      sourcesByTargetEdge.set(edgeId, new Set([...(sourcesByTargetEdge.get(edgeId) ?? []), String(plan.connection.sourceConnectionId)]));
    }
    for (const plan of notePlans) {
        const { connection, direction, signature, targetRow, expectedIdentity } = plan;
        const fromFields = direction.from?.sourceSystemId ? aliasesBySourceId.get(direction.from.sourceSystemId) : undefined;
        const toFields = direction.to?.sourceSystemId ? aliasesBySourceId.get(direction.to.sourceSystemId) : undefined;
        const connectionFields = noteConnectionsBySourceId.get(String(connection.sourceConnectionId));
        const signatureNote = signature?.sourceSignatureId ? signatureAnnotationsBySourceId.get(signature.sourceSignatureId) : undefined;
        const destinationClass = typeof direction.to?.eveSolarSystemId === "number"
          ? this.systemClass(direction.to.eveSolarSystemId) : null;
        const rendered = renderAllianceNote({ fromSourceSystemId: direction.from?.sourceSystemId,
          toSourceSystemId: direction.to?.sourceSystemId, fromAlias: fromFields?.alias, fromIsHome: fromFields?.isHome,
          toAlias: toFields?.alias, toIsHome: toFields?.isHome, signatureCode: signature?.signatureCode,
          destinationClass, size: connectionFields?.size, statusAnnotation: signatureNote ?? toFields?.statusAnnotation ?? undefined,
          knownStatusAnnotations, reverse: direction.reverse });
        if (toFields?.statusAnnotationConflict) rendered.blockers.push("statusAnnotation: source map and selected-system status values disagree");
        rendered.blockers.push(...plan.directionBlockers);
        const targetEdgeReused = plan.edge && (sourcesByTargetEdge.get(String(plan.edge.id))?.size ?? 0) > 1;
        if (targetEdgeReused) rendered.blockers.push("Nexum connection matches multiple source connections");
        const identityMatched = plan.identityMatched && !targetEdgeReused;
        const eligibility = allianceNoteWriteEligibility({ rendered,
          snapshotFresh: snapshotReasons.length === 0,
          identityMatched, targetRowAvailable: !!targetRow,
          currentNote: targetRow?.notes, decisionBoundaryHeld: true });
        const pending = eligibility.eligible && typeof rendered.note === "string" && targetRow?.notes !== rendered.note;
        allianceNotes.push({ source_connection_id: connection.sourceConnectionId, source_signature_key: direction.key,
          system_id: targetRow?._systemId ?? null, signature_id: targetRow?.id ?? null,
          ...(expectedIdentity ? { expected_identity: expectedIdentity } : {}),
          eligible_for_write: eligibility.eligible, pending,
          ...(includeNoteWriteDetails ? { desired_note: rendered.note ?? null, actual_note: targetRow?.notes ?? null } : {}),
          blocking_fields: [...new Set(eligibility.blockers)] });
    }
     const topologyCheck = validateWormholesystemsTopologyRequest(topologyCandidateFromFixture(sourceFixture), this.now(), maxStalenessMs ?? 0);
     const topologyBlockers = [...new Set([...snapshotReasons, ...topologyCheck.blockers,
       "data writes are not implemented in this diagnostic milestone", ...uniqueNexumEvidenceBlockers])];
    const sourceSnapshotEligible = snapshotReasons.length === 0;
    const fullMatchingBlockers = [...snapshotReasons, ...uniqueNexumEvidenceBlockers];
    if (conflicts.length) fullMatchingBlockers.push("one or more source/Nexum identity or edge conflicts prevent full matching eligibility");
    const unmatchedConnections = unmatched.some(item => typeof item.source_connection_id === "string");
    if (unmatchedConnections) fullMatchingBlockers.push("one or more source connections lack a complete Nexum identity match");
    const fullMatchingEligible = sourceSnapshotEligible && uniqueNexumEvidenceBlockers.length === 0 && conflicts.length === 0 && !unmatchedConnections;
    const resourceFreshness = { nexum_map_health: nexumMap.health ?? "unknown", map_hydrated_at: nexumMap.hydrated_at ?? null,
      map_cache_fresh: mapCacheFresh, maximum_staleness_ms: maxStalenessMs ?? null, signature_resource_count: resourceFetchTimes.length,
      oldest_signature_resource_fetched_at: resourceFetchTimes.length ? Math.min(...resourceFetchTimes) : null,
      newest_signature_resource_fetched_at: resourceFetchTimes.length ? Math.max(...resourceFetchTimes) : null,
      matching_evidence_blockers: uniqueNexumEvidenceBlockers };
     const topologyEligible = false;
      const allianceNotesEligible = allianceNotes.some(note => note.eligible_for_write && note.pending);
     const writesEnabled = false;
    return { ...current, source_snapshot_eligible_for_matching: sourceSnapshotEligible,
      source_snapshot_blockers: snapshotReasons, nexum_matching_blockers: uniqueNexumEvidenceBlockers,
      full_matching_blockers: [...new Set(fullMatchingBlockers)], eligible_for_matching: fullMatchingEligible,
      eligible_for_topology_write: topologyEligible,
      eligible_for_alliance_note_writes: allianceNotesEligible, eligible_for_writes: writesEnabled,
      preview: { local_only: true, upstream_calls: 0, source_revision: row.revision_or_digest,
        source_snapshot: { source_identity: row.source_identity, source_api_map_id: row.source_api_map_id,
          revision_or_digest: row.revision_or_digest, fetched_at: row.fetched_at,
          fresh_for_matching: snapshotReasons.length === 0, blockers: snapshotReasons },
        source_signature_classification: { status: classificationStatus, total: classificationRows.length,
          omitted: Math.max(0, classificationRows.length - sourceSignatureEvidence.length), signatures: sourceSignatureEvidence },
        matching_performed: true, stored_snapshot_eligible_for_matching: !!row.eligible_for_matching,
        source_snapshot_eligible_for_matching: sourceSnapshotEligible, snapshot_eligible_for_matching: sourceSnapshotEligible,
        full_matching_eligible: fullMatchingEligible, full_matching_blockers: [...new Set(fullMatchingBlockers)],
        snapshot_blockers: snapshotReasons, nexum_cache: resourceFreshness,
        matched, unmatched, conflicts, counts: { matched: matched.length, identity_matches_without_conflict: matched.filter(item => item.identity_match_complete).length,
          unmatched: unmatched.length, conflicts: conflicts.length },
         alliance_notes: allianceNotes,
          topology_apply: { eligible: topologyEligible, blockers: topologyBlockers },
         final_names: "alliance_note_renderer", writes_enabled: writesEnabled, nexum_writes_attempted: false } };
  }
}

let service: WormholeSystemsService | undefined;
export function getWormholeSystems(): WormholeSystemsService {
  if (!service) {
    const db: Database.Database = getStateDatabase();
    const store = getNexum().store;
    const dir = path.dirname(process.env.GALAXY_STATE_DB ?? path.join(os.homedir(), ".eve-sde", "galaxy-state.db"));
    service = new WormholeSystemsService(store, new SecretStore(db, path.join(dir, "galaxy-secret.key")));
  }
  return service;
}
export async function resetWormholeSystemsForTests(): Promise<void> { await service?.stop(); service = undefined; }
export async function stopWormholeSystems(): Promise<void> { await service?.stop(); }
