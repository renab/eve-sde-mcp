import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
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

const MAX_SYSTEM_DETAIL_REQUESTS = 100;
const SYSTEM_DETAIL_PACING_MS = 1_000;
const MAX_SOURCE_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_STALENESS_ENV = "GALAXY_WORMSYSTEMS_MAX_STALENESS_MS";
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
};

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
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS wormholesystems_credentials (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wormholesystems_config (id TEXT PRIMARY KEY CHECK(id='singleton'), config_json TEXT NOT NULL CHECK(json_valid(config_json)));
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
        source_calls INTEGER NOT NULL DEFAULT 0, revision_ordering TEXT NOT NULL DEFAULT 'unknown'
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
  }

  private config(): SourceConfig | undefined {
    const row = this.store.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as { config_json: string } | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.config_json) as SourceConfig;
    return { ...value, configurationRevision: value.configurationRevision ?? `legacy:${value.configuredAt}`,
      liveSyncEnabled: value.liveSyncEnabled === true, schemaValidatedAt: value.schemaValidatedAt ?? null,
      validatedCredentialId: value.validatedCredentialId ?? null };
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

  private maxStalenessMs(): number | undefined {
    const raw = process.env[MAX_STALENESS_ENV];
    if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
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
    if (Object.values(values).some(value => typeof value === "string" && value === token))
      throw new Error("Credential value cannot match any source configuration field");
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
    const config: SourceConfig = { origin, apiPathPrefix, mapRouteKey: input.map_route_key, canonicalMapId,
      upstreamMapId, credentialId, configuredAt: this.now(), configurationRevision: crypto.randomUUID(),
      liveSyncEnabled: false, schemaValidatedAt: null, validatedCredentialId: null };
    this.withMapBoundarySync([...(existing ? [existing.canonicalMapId] : []), canonicalMapId], () => this.store.db.transaction(() => {
      this.saveConfig(config);
      for (const id of new Set([existing?.canonicalMapId, canonicalMapId].filter((value): value is string => !!value)))
        this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(id);
    })());
    return this.configuration();
  }

  configuration(): Json {
    const config = this.config();
    if (!config) return { configured: false, live_sync_enabled: false, eligible_for_matching: false, eligible_for_writes: false };
    return { configured: true, origin: config.origin, api_path_prefix: config.apiPathPrefix, map_route_key: config.mapRouteKey,
      canonical_map_id: config.canonicalMapId, upstream_map_id: config.upstreamMapId, credential_id: config.credentialId,
      configured_at: config.configuredAt, schema_validated_at: config.schemaValidatedAt, live_sync_enabled: config.liveSyncEnabled,
      eligible_for_matching: false, eligible_for_writes: false,
      activation_blockers: [...(config.schemaValidatedAt && config.validatedCredentialId === config.credentialId ? [] : ["run a successful connection and selected-map schema test"]),
        ...(config.liveSyncEnabled ? [] : ["source snapshot synchronization is not operator-enabled"]),
        "authority records and bookmark specification are unavailable; final names and Nexum apply remain blocked"] };
  }

  removeConfiguration(): Json {
    this.assertNoActiveSync();
    const config = this.config();
    this.withMapBoundarySync(config ? [config.canonicalMapId] : [], () => this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM wormholesystems_config WHERE id='singleton'").run();
      if (config) this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(config.canonicalMapId);
    })());
    return this.configuration();
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
          this.saveConfig({ ...config, configurationRevision: crypto.randomUUID(), liveSyncEnabled: false, schemaValidatedAt: null, validatedCredentialId: null });
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
      }
    })());
    return { removed: true, credential_id: id, source_configuration_removed: this.config() === undefined };
  }

  private async fetchAccessibleMaps(): Promise<ApiMapRecord[]> {
    const config = this.config();
    if (!config) throw new Error("WormholeSystems source is not configured");
    const maps = await this.client(config).listMaps(this.lifetime.signal);
    this.rejectSecretEcho(maps, this.token(config));
    return maps;
  }

  private invalidateActivation(config: SourceConfig): void {
    this.saveConfig({ ...config, configurationRevision: crypto.randomUUID(), liveSyncEnabled: false, schemaValidatedAt: null, validatedCredentialId: null });
    this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(config.canonicalMapId);
  }

  private snapshotBlockers(mapId: string, row: any, maxStalenessMs = this.maxStalenessMs()): string[] {
    const blockers: string[] = [];
    if (!row?.eligible_for_matching) blockers.push("stored source snapshot is marked ineligible");
    const config = this.config();
    if (!config || config.canonicalMapId !== mapId) blockers.push("source configuration does not target this canonical map");
    else {
      if (!config.liveSyncEnabled) blockers.push("source synchronization is not currently enabled");
      if (!config.schemaValidatedAt || config.validatedCredentialId !== config.credentialId)
        blockers.push("current source credential has not passed the selected-map schema test");
      if (row.source_origin !== config.origin || row.source_api_map_id !== config.upstreamMapId ||
          row.source_identity !== `wormholesystems:${JSON.stringify([config.origin, config.upstreamMapId])}`)
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
    if (maxStalenessMs === undefined) blockers.push(`maximum matching staleness is not configured (${MAX_STALENESS_ENV})`);
    const fetchedAt = row?.fetched_at ? Date.parse(row.fetched_at) : NaN;
    if (!Number.isFinite(fetchedAt) || fetchedAt > this.now()) blockers.push("source snapshot fetch time is missing or future-dated");
    else if (maxStalenessMs !== undefined && this.now() - fetchedAt > maxStalenessMs)
      blockers.push("source snapshot exceeds the configured maximum matching staleness");
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
        const selected = maps.find(map => map.id === currentConfig.upstreamMapId);
        if (!selected) {
          await mapDecisionBoundary.run(currentConfig.canonicalMapId, () => this.invalidateActivation(currentConfig!));
          return { status: "inaccessible_or_not_listed", accessible_map_count: maps.length,
            selected_upstream_map_id: currentConfig.upstreamMapId, authenticated: true, live_sync_enabled: false };
        }
        const routeValue = currentConfig.mapRouteKey === "id" ? selected.id : selected.slug;
        if (!routeValue) {
          await mapDecisionBoundary.run(currentConfig.canonicalMapId, () => this.invalidateActivation(currentConfig!));
          return { status: "route_key_unavailable", accessible_map_count: maps.length,
            selected_upstream_map_id: currentConfig.upstreamMapId, authenticated: true, live_sync_enabled: false };
        }
        const detail = await client.mapDetail(selected.id, routeValue, this.lifetime.signal);
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
          this.store.db.prepare("UPDATE wormholesystems_credentials SET metadata=json_set(metadata,'$.validation_status','maps_detail_schema_ok','$.last_test_at',?) WHERE id=?")
            .run(this.now(), currentConfig.credentialId);
          this.saveConfig({ ...currentConfig, schemaValidatedAt: this.now(), validatedCredentialId: currentConfig.credentialId });
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
    if (!config.schemaValidatedAt || config.validatedCredentialId !== config.credentialId)
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
    const pending = this.syncs.get(mapId);
    if (pending) return pending;
    const task = this.track(() => this.syncConfiguredMap(mapId, config));
    this.syncs.set(mapId, task);
    try { return await task; }
    finally { if (this.syncs.get(mapId) === task) this.syncs.delete(mapId); }
  }

  private async syncConfiguredMap(mapId: string, config: SourceConfig): Promise<Json> {
    const attemptedAt = this.now();
    let revisionOrdering: "unknown" | "observed_at" = "unknown";
    const snapshot = this.store.db.prepare("SELECT source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json FROM wormholesystems_source_snapshots WHERE map_id=?").get(mapId) as any;
    const credentialVersion = Number(this.metadata(config.credentialId).credential_version) || 1;
    if (!config.liveSyncEnabled || !config.schemaValidatedAt || config.validatedCredentialId !== config.credentialId) {
      this.store.db.prepare("INSERT INTO wormholesystems_source_runs(map_id,status,attempted_at,error_status,error_message,source_calls) VALUES (?,'disabled',?,0,?,0)")
        .run(mapId, attemptedAt, "Source synchronization has not been operator-enabled after a successful schema test.");
      return { map_id: mapId, status: "disabled", fetched: false, source_calls: 0,
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
      const selected = maps.find(map => map.id === config.upstreamMapId);
      if (!selected) {
        await mapDecisionBoundary.run(mapId, () => this.store.db.transaction(() => {
          this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(mapId);
          this.store.db.prepare("INSERT INTO wormholesystems_source_runs(map_id,status,attempted_at,error_status,error_message,source_calls) VALUES (?,'inaccessible_or_not_listed',?,404,?,?)")
            .run(mapId, attemptedAt, "Selected upstream map is not in the accessible map list.", sourceCalls);
        })());
        return { map_id: mapId, status: "inaccessible_or_not_listed", fetched: false, source_calls: 1, eligible_for_matching: false,
          eligible_for_writes: false, nexum_writes_attempted: false, last_good_snapshot_retained: !!snapshot };
      }
      const routeValue = config.mapRouteKey === "id" ? selected.id : selected.slug;
      if (!routeValue) throw new WormholeSystemsError(0, 0, "Configured WormholeSystems map route key is unavailable");
      sourceCalls++;
      const detail = await client.mapDetail(selected.id, routeValue, this.lifetime.signal);
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
      const payload = { schema: "wormholesystems-source-v1", adapterVersion: 1, revisionOrdering,
        adapterDiagnostics: normalized.diagnostics, fixture: normalized.fixture };
      const payloadJson = JSON.stringify(payload);
      if (Buffer.byteLength(payloadJson, "utf8") > MAX_SOURCE_SNAPSHOT_BYTES)
        throw new WormholeSystemsError(0, 0, "WormholeSystems normalized snapshot exceeded the size limit");
      await mapDecisionBoundary.run(mapId, () => {
        const matchingStalenessConfigured = this.maxStalenessMs() !== undefined;
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
            normalized.fixture.observedAt, payloadJson, matchingStalenessConfigured ? 1 : 0, config.credentialId, credentialVersion, config.configuredAt,
            config.configurationRevision);
        this.store.db.prepare("INSERT INTO wormholesystems_source_runs(map_id,status,attempted_at,succeeded_at,revision_or_digest,error_status,error_message,source_calls,revision_ordering) VALUES (?,'snapshot_validated',?,?,?,0,NULL,?,?)")
          .run(mapId, attemptedAt, fetchedAtMs, revision, sourceCalls, revisionOrdering);
        })();
      });
      return { map_id: mapId, status: "snapshot_validated", fetched: true, source_calls: sourceCalls,
        source_identity: sourceIdentity, source_api_map_id: selected.id, revision_or_digest: revision, revision_ordering: revisionOrdering,
        fetched_at: fetchedAt, observed_at: normalized.fixture.observedAt,
        ...normalized.diagnostics, eligible_for_matching: this.maxStalenessMs() !== undefined, eligible_for_writes: false, nexum_writes_attempted: false,
        note: "Validated source snapshot stored locally. Nexum matching is preview-only; authority-dependent names and all writes remain blocked." };
    } catch (error) {
      const failure = safeError(error);
      await mapDecisionBoundary.run(mapId, () => this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE wormholesystems_source_snapshots SET eligible_for_matching=0 WHERE map_id=?").run(mapId);
        this.store.db.prepare("INSERT INTO wormholesystems_source_runs(map_id,status,attempted_at,error_status,error_message,source_calls,revision_ordering) VALUES (?,'fetch_failed',?,?,?,?,?)")
          .run(mapId, attemptedAt, failure.status, failure.message, sourceCalls, revisionOrdering);
      })());
      return { map_id: mapId, status: "fetch_failed", fetched: false, source_calls: sourceCalls,
        eligible_for_matching: false, eligible_for_writes: false, nexum_writes_attempted: false,
        last_good_snapshot_retained: !!snapshot, last_good_revision_or_digest: snapshot?.revision_or_digest ?? null,
        error_status: failure.status, error: failure.message };
    }
  }

  status(canonicalMapId: string): Json {
    const mapId = this.canonicalMap(canonicalMapId);
    const snapshot = this.store.db.prepare("SELECT * FROM wormholesystems_source_snapshots WHERE map_id=?").get(mapId) as any;
    const run = this.store.db.prepare("SELECT status,attempted_at,succeeded_at,revision_or_digest,error_status,error_message,source_calls,revision_ordering FROM wormholesystems_source_runs WHERE map_id=? ORDER BY id DESC LIMIT 1").get(mapId) as any;
    const config = this.config();
    const payload = snapshot ? JSON.parse(snapshot.payload_json) as Json : undefined;
    const fixture = payload?.fixture as Json | undefined;
    const adapterDiagnostics = payload?.adapterDiagnostics as Json | undefined;
    const sourceMetadata = fixture?.sourceMetadata as Json | undefined;
    const sourceMap = sourceMetadata?.map as Json | undefined;
    const maxStalenessMs = this.maxStalenessMs();
    const matchBlockers = snapshot ? this.snapshotBlockers(mapId, snapshot, maxStalenessMs) : ["no source snapshot is stored"];
    return { map_id: mapId, configured: config?.canonicalMapId === mapId,
       integration_mode: config?.liveSyncEnabled ? "operator_enabled_read_only_source_sync" : "source_sync_disabled",
       live_sync_enabled: !!config?.liveSyncEnabled,
       connection_test_validated: !!(config?.schemaValidatedAt && config.validatedCredentialId === config.credentialId),
       snapshot_present: !!snapshot, ...(snapshot ? { source_identity: snapshot.source_identity, source_origin: snapshot.source_origin,
           source_api_map_id: snapshot.source_api_map_id, revision_or_digest: snapshot.revision_or_digest,
           revision_ordering: payload?.revisionOrdering ?? "unknown",
           fetched_at: snapshot.fetched_at, fetched_age_ms: this.now() - Date.parse(snapshot.fetched_at),
           observed_at: snapshot.observed_at, observed_age_ms: snapshot.observed_at ? this.now() - Date.parse(snapshot.observed_at) : null,
            eligible_for_matching: matchBlockers.length === 0, stored_snapshot_eligible_for_matching: !!snapshot.eligible_for_matching,
            matching_blockers: matchBlockers,
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
             connection_freshness_deadlines: ((fixture?.connections ?? []) as Json[]).filter(connection => !!connection.freshUntil).length } } : { eligible_for_matching: false }),
        staleness_policy: { configuration_key: MAX_STALENESS_ENV, max_age_ms: maxStalenessMs ?? null,
          configured: maxStalenessMs !== undefined, status: maxStalenessMs === undefined ? "blocked_missing_or_invalid" : "configured" },
        eligible_for_writes: false, last_attempt: run ? { status: run.status, attempted_at: run.attempted_at,
          succeeded_at: run.succeeded_at, source_calls: run.source_calls, revision_or_digest: run.revision_or_digest,
          revision_ordering: run.revision_ordering,
          error_status: run.error_status, error: run.error_message } : null,
       preview: { local_only: true, upstream_calls: 0, authority_dependent_bookmark_notes: "blocked_unavailable_authority_records", writes_enabled: false } };
  }

  preview(canonicalMapId: string): Json {
    const mapId = this.canonicalMap(canonicalMapId);
    const locked = mapDecisionBoundary.runSync(mapId, () => this.previewLocked(mapId));
    if (!locked.acquired) return { ...this.status(mapId), preview: { local_only: true, upstream_calls: 0, matching_performed: false,
      matched: [], unmatched: [], conflicts: [{ reason: "Nexum map decision boundary is busy; preview is blocked until a coherent state is available" }],
      final_names: "blocked_unavailable_authority_records", writes_enabled: false, nexum_writes_attempted: false } };
    return locked.value;
  }

  private previewLocked(mapId: string): Json {
    const current = this.status(mapId);
    const row = this.store.db.prepare("SELECT * FROM wormholesystems_source_snapshots WHERE map_id=?").get(mapId) as any;
    if (!row) return { ...current, preview: { local_only: true, upstream_calls: 0, matching_performed: false,
      matched: [], unmatched: [], conflicts: [], final_names: "blocked_unavailable_authority_records", writes_enabled: false } };
    const payload = JSON.parse(row.payload_json) as Json;
    if (payload?.schema !== "wormholesystems-source-v1" || payload?.adapterVersion !== 1 || !payload.fixture || payload.fixture.sourceKind !== "wormholesystems")
      return { ...current, preview: { local_only: true, upstream_calls: 0, matching_performed: false, matched: [], unmatched: [],
        conflicts: [{ reason: "stored snapshot does not match the validated adapter version" }],
        final_names: "blocked_unavailable_authority_records", writes_enabled: false } };
    const source = payload.fixture as Json;
    const state = this.store.state(mapId) as Json;
    const nexumMap = this.store.map(mapId);
    const maxStalenessMs = this.maxStalenessMs();
    const snapshotReasons = this.snapshotBlockers(mapId, row, maxStalenessMs);
    const mapFetchedAt = Number(nexumMap.hydrated_at);
    const mapCacheFresh = maxStalenessMs !== undefined && Number.isFinite(mapFetchedAt) && mapFetchedAt <= this.now() &&
      this.now() - mapFetchedAt <= maxStalenessMs;
    const sourceSystems = new Map<number, Json[]>([]);
    for (const system of (source.systems ?? []) as Json[]) sourceSystems.set(system.eveSolarSystemId, [...(sourceSystems.get(system.eveSolarSystemId) ?? []), system]);
    const nexumSystems = (state.systems ?? []) as Json[];
    const nexumSignatures: Json[] = [];
    const resourceFetchTimes: number[] = [];
    for (const system of nexumSystems) {
      const resource = this.store.resources(mapId, String(system.id));
      if (Number.isFinite(resource.signatures?.fetched_at)) resourceFetchTimes.push(Number(resource.signatures.fetched_at));
      for (const signature of (resource.signatures?.items ?? []) as Json[])
        nexumSignatures.push({ ...signature, _systemId: String(system.id), _resourceFetchedAt: resource.signatures?.fetched_at ?? null });
    }
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
      const sourceObservationFresh = (observedAt: unknown) => {
        if (maxStalenessMs === undefined || typeof observedAt !== "string") return false;
        const observedAtMs = Date.parse(observedAt);
        const now = this.now();
        return Number.isFinite(observedAtMs) && observedAtMs <= now && now - observedAtMs <= maxStalenessMs;
      };
      const sourceFresh = !!connection.observedAt && Date.parse(connection.observedAt) <= this.now() && !!connection.freshUntil && Date.parse(connection.freshUntil) >= this.now() &&
        !!from.observedAt && Date.parse(from.observedAt) <= this.now() && !!from.freshUntil && Date.parse(from.freshUntil) >= this.now() &&
        !!to.observedAt && Date.parse(to.observedAt) <= this.now() && !!to.freshUntil && Date.parse(to.freshUntil) >= this.now() &&
        sourceObservationFresh(connection.observedAt) && sourceObservationFresh(from.observedAt) && sourceObservationFresh(to.observedAt) &&
        sourceObservationFresh(sourceFrom[0].observedAt) && sourceObservationFresh(sourceTo[0].observedAt);
      const sourceStateActive = connection.state === "active" && from.status === "active" && to.status === "active";
      const nexumBroken = candidate.edge.broken === true || ["broken", "expired"].includes(String(candidate.edge.timeStatus ?? "").toLowerCase());
      const nexumStateKnown = candidate.edge.broken === false && typeof candidate.edge.timeStatus === "string" &&
        !!candidate.edge.timeStatus && !["unknown", "unavailable"].includes(candidate.edge.timeStatus.toLowerCase()) &&
        candidate.fromRow.status === "active" && candidate.toRow.status === "active";
      const reasons = [...snapshotReasons, !resourceFresh && (maxStalenessMs === undefined ? `maximum matching staleness is not configured (${MAX_STALENESS_ENV})` : "Nexum signature cache is missing, future-dated or exceeds the configured maximum staleness"),
        (nexumMap.health !== "live" || !mapCacheFresh) && "Nexum map cache is not live or exceeds the configured maximum staleness",
        !sourceFresh && "source observation is missing, future-dated or exceeds the configured maximum staleness, or freshness evidence is expired", !sourceStateActive && "source connection or both directional signatures are not active",
        !nexumStateKnown && "Nexum connection or signature status is unknown", nexumBroken && "Nexum connection is broken or expired"].filter(Boolean);
      matched.push({ source_connection_id: connection.sourceConnectionId, source_signature_keys: keys,
        nexum_connection_id: candidate.edge.id, nexum_signature_row_ids: [candidate.fromRow.id, candidate.toRow.id],
        status: reasons.length ? "identity_match_conflicted" : "identity_match_only", identity_match_complete: reasons.length === 0,
        eligible_for_reconciliation: false, blocking_reasons: [...reasons, "exact authority records and bookmark specification are unavailable"],
        proposed_name: null, action: "none" });
      if (reasons.length) pushIssue(conflicts, connection, reasons.join("; "), keys);
    }
    const allSourceConnectionIds = new Set(((source.connections ?? []) as Json[]).map(connection => connection.sourceConnectionId));
    for (const signature of (source.signatures ?? []) as Json[]) if (signature.sourceConnectionId && !allSourceConnectionIds.has(signature.sourceConnectionId))
      unmatched.push({ source_connection_id: signature.sourceConnectionId, source_signature_keys: [signature.signatureKey], reason: "source signature has no normalized connection record" });
    const resourceFreshness = { nexum_map_health: nexumMap.health ?? "unknown", map_hydrated_at: nexumMap.hydrated_at ?? null,
      map_cache_fresh: mapCacheFresh, maximum_staleness_ms: maxStalenessMs ?? null, signature_resource_count: resourceFetchTimes.length,
      oldest_signature_resource_fetched_at: resourceFetchTimes.length ? Math.min(...resourceFetchTimes) : null,
      newest_signature_resource_fetched_at: resourceFetchTimes.length ? Math.max(...resourceFetchTimes) : null };
    return { ...current, preview: { local_only: true, upstream_calls: 0, source_revision: row.revision_or_digest,
      matching_performed: true, snapshot_eligible_for_matching: snapshotReasons.length === 0,
      stored_snapshot_eligible_for_matching: !!row.eligible_for_matching, snapshot_blockers: snapshotReasons, nexum_cache: resourceFreshness,
       matched, unmatched, conflicts, counts: { matched: matched.length, identity_matches_without_conflict: matched.filter(item => item.identity_match_complete).length,
        unmatched: unmatched.length, conflicts: conflicts.length },
      final_names: "blocked_unavailable_authority_records", writes_enabled: false, nexum_writes_attempted: false } };
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
