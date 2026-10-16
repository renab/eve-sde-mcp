import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStateDatabase } from "../../src/persistence.js";
import { SecretStore, redactSecrets } from "../../src/secrets.js";
import { NexumStore } from "../../src/nexum-store.js";
import { NexumService } from "../../src/nexum.js";
import { registerWormholeSystemsTools } from "../../src/tools/wormholesystems.js";
import {
  WormholeSystemsClient, WormholeSystemsError, validateWormholeSystemsOrigin, validateWormholeSystemsPathPrefix,
} from "../../src/wormholesystems-client.js";
import { canonicalSolarSystemClassFromSde, WormholeSystemsService } from "../../src/wormholesystems.js";
import { normalizeSourceSnapshot } from "../../src/wormholesystems-adapter.js";
import { mapDecisionBoundary } from "../../src/map-decision-boundary.js";

const tmpDirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const response = (payload: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(payload), { status, headers });

function harness(transport: typeof fetch = vi.fn(async () => response({ data: [] })), sleep: (ms: number) => Promise<void> = async () => {},
  systemClass?: (eveSystemId: number) => string | null, systemExists: (eveSystemId: number) => boolean = () => true,
  now: () => number = () => Date.parse("2026-10-13T12:00:00.000Z")) {
  const db = openStateDatabase(":memory:");
  const store = new NexumStore(db, now);
  const credential = { id: "nexum-test", base_url: "https://nexum.invalid", label: "fixture", enabled: true };
  store.saveCredential(credential);
  store.discover(credential, [{ id: "target-map", name: "Target" }, { id: "other-map", name: "Other" }], credential.base_url);
  const secretValues = new Map<string, string>();
  const secrets = { put: (id: string, value: string) => secretValues.set(id, value), get: (id: string) => {
    const value = secretValues.get(id); if (!value) throw new Error("Credential secret unavailable"); return value;
  }, remove: (id: string) => secretValues.delete(id) };
  const nexumWrites = {
    writeWormholesystemsTopology: vi.fn(async () => ({ status: "ok", checkpoint: { accepted: true, replayed: false, partial: false } } as any)),
    writeWormholesystemsSignatureNotes: vi.fn(async (_map: string, changes: Array<any>, validateSource?: () => string[]) => {
      const blockers = validateSource?.() ?? [];
      return blockers.length ? { written: 0, status: "blocked", blockers,
        items: changes.map((_: any, item_index: number) => ({ item_index, status: item_index ? "not_attempted" : "blocked" })) } as any :
        { written: changes.length, status: "completed", items: changes.map((_: any, item_index: number) => ({ item_index, status: "written" })) } as any;
    }),
  };
  const service = new WormholeSystemsService(store, secrets, transport, now, sleep,
    nexumWrites, systemClass, systemExists);
  const maps = store.maps();
  return { db, store, service, secrets, secretValues, nexumWrites, targetMap: maps.find(map => map.name === "Target")!.id, otherMap: maps.find(map => map.name === "Other")!.id };
}

async function configured(service: WormholeSystemsService, target: string, route: "id" | "slug" = "id") {
  const credential = service.addCredential({ api_token: "token-do-not-echo", label: "Fixture key" });
  service.configure({ origin: "https://wormholes.invalid", api_path_prefix: "/api", map_route_key: route,
    canonical_map_id: target, upstream_map_id: route === "id" ? "api-map-7" : "api-slug", credential_id: credential.id });
}

const selectedMapDetail = (id = "api-map-7") => ({ id, slug: "api-slug", map_solarsystems: [
  { id: "map-system-test", map_id: id, solarsystem_id: 31_000_001 },
], map_connections: [] });
const systemDetail = (id: string, eveId: number, signatures: unknown[] = [], mapId = "api-map-7") => ({ data: { id, map_id: mapId, solarsystem_id: eveId,
  signatures, map_connections: [], audits: [] } });
const testSystemDetail = () => systemDetail("map-system-test", 31_000_001);
async function enableAfterTest(service: WormholeSystemsService) {
  const result = await service.testConnection();
  expect(result).toMatchObject({ status: "maps_detail_schema_ok", authenticated: true });
  service.enableSync();
}

describe("WormholeSystems GET client", () => {
  it("validates an exact HTTPS origin and a path-only prefix", () => {
    expect(validateWormholeSystemsOrigin("https://self-hosted.example:8443")).toBe("https://self-hosted.example:8443");
    for (const value of ["http://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?x=1", "https://example.test#x", "https://0177.1", "https://example.test:"])
      expect(() => validateWormholeSystemsOrigin(value)).toThrow(WormholeSystemsError);
    expect(validateWormholeSystemsPathPrefix("/api/v2")).toBe("/api/v2");
    for (const value of ["api", "//evil.test", "/api/../other", "/api/%2e%2e", "/api?x=1", "/api/"])
      expect(() => validateWormholeSystemsPathPrefix(value)).toThrow(WormholeSystemsError);
  });

  it("keeps bearer requests on the exact origin, uses GET, rejects redirects and never follows a redirect target", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/steal" } });
    });
    const client = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "secret-value", transport as typeof fetch, { maxAttempts: 1 });
    await expect(client.listMaps()).rejects.toMatchObject({ status: 302 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://source.example/api/maps");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.redirect).toBe("error");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-value");
  });

  it("validates accessible map records and rejects malformed schemas", async () => {
    const good = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x",
      vi.fn(async () => response({ data: [{ id: 7, slug: "seven" }] })) as typeof fetch);
    await expect(good.listMaps()).resolves.toEqual([{ id: "7", slug: "seven" }]);
    const bad = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x",
      vi.fn(async () => response({ data: [{ slug: "missing-id" }] })) as typeof fetch);
    await expect(bad.listMaps()).rejects.toMatchObject({ status: 0, message: "Malformed WormholeSystems maps response" });
  });

  it("uses the returned API map ID route and rejects a detail identity mismatch", async () => {
    const paths: string[] = [];
    const transport = vi.fn(async (input: string | URL | Request) => {
      paths.push(String(input));
      return response({ data: { id: paths.length === 1 ? "api-map-7" : "different-map", slug: "stable-slug" } });
    });
    const client = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "slug" }, "x", transport as typeof fetch);
    await client.mapDetail("api-map-7");
    expect(paths[0]).toBe("https://source.example/api/maps/api-map-7");
    await expect(client.mapDetail("api-map-7")).rejects.toMatchObject({ message: "WormholeSystems map detail identity mismatch" });
  });

  it("exposes an explicit solar-system detail GET and bounds response bytes", async () => {
    const calls: string[] = [];
    const transport = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return response({ data: { id: "map-system-1", signatures: [], map_connections: [], audits: [] } });
    });
    const client = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x", transport as typeof fetch);
    await client.solarSystemDetail("map-system-1");
    expect(calls).toEqual(["https://source.example/api/map-solarsystems/map-system-1"]);
    await expect(client.solarSystemDetail("..")).rejects.toMatchObject({ message: "Invalid WormholeSystems solar-system selection" });
    await expect(client.mapDetail("../api")).rejects.toMatchObject({ message: "Invalid WormholeSystems map selection" });
    await expect(client.mapDetail("%2e%2e")).rejects.toMatchObject({ message: "Invalid WormholeSystems map selection" });
    expect(calls).toHaveLength(1);
    const oversized = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x",
      vi.fn(async () => response({ payload: "x".repeat(2000) })) as typeof fetch, { maxBytes: 1024, maxAttempts: 1 });
    await expect(oversized.listMaps()).rejects.toMatchObject({ message: "WormholeSystems response exceeded the size limit" });
  });

  it("honors Retry-After for bounded transient retries but does not retry auth failures", async () => {
    const sleep = vi.fn(async () => {});
    const transport = vi.fn().mockResolvedValueOnce(response({}, 503, { "retry-after": "2" })).mockResolvedValueOnce(response({ data: [] }));
    const client = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x", transport as typeof fetch,
      { sleep, maxAttempts: 3, now: () => 0 });
    await client.listMaps();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    const denied = vi.fn(async () => response({}, 401));
    const authClient = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x", denied as typeof fetch, { sleep, maxAttempts: 3 });
    await expect(authClient.listMaps()).rejects.toMatchObject({ status: 401 });
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("parses HTTP-date Retry-After values", async () => {
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    const sleep = vi.fn(async () => {});
    const transport = vi.fn().mockResolvedValueOnce(response({}, 429, { "retry-after": new Date(now + 3_000).toUTCString() }))
      .mockResolvedValueOnce(response({ data: [] }));
    const client = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x", transport as typeof fetch,
      { sleep, now: () => now, maxAttempts: 2 });
    await client.listMaps();
    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not retry ahead of a long Retry-After and aborts a pending backoff on shutdown", async () => {
    const transport = vi.fn(async () => response({}, 503, { "retry-after": "60" }));
    const longWaitClient = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x", transport as typeof fetch, { maxAttempts: 3 });
    await expect(longWaitClient.listMaps()).rejects.toMatchObject({ status: 503, retryAfterMs: 60_000 });
    expect(transport).toHaveBeenCalledTimes(1);

    const abortTransport = vi.fn(async () => response({}, 503, { "retry-after": "20" }));
    const controller = new AbortController();
    const abortClient = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x", abortTransport as typeof fetch, { maxAttempts: 3 });
    const pending = abortClient.listMaps(controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ status: 0, message: "WormholeSystems request aborted" });
    expect(abortTransport).toHaveBeenCalledTimes(1);
  });

  it("aborts on timeout and bounds the number of attempts", async () => {
    const transport = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const client = new WormholeSystemsClient({ origin: "https://source.example", apiPathPrefix: "/api", mapRouteKey: "id" }, "x", transport as typeof fetch,
      { timeoutMs: 100, maxAttempts: 1 });
    await expect(client.listMaps()).rejects.toMatchObject({ status: 0, message: "WormholeSystems request failed or timed out" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("WormholeSystems service and MCP controls", () => {
  it("encrypts credential storage and returns only safe metadata through CRUD", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wormholesystems-test-")); tmpDirs.push(dir);
    const db = openStateDatabase(":memory:");
    const secrets = new SecretStore(db, path.join(dir, "galaxy-secret.key"));
    const store = new NexumStore(db);
    const service = new WormholeSystemsService(store, secrets);
    const token = crypto.randomBytes(32).toString("base64url");
    const added = service.addCredential({ api_token: token, label: "source" });
    expect(JSON.stringify(added)).not.toContain(token);
    expect(service.listCredentials()).toHaveLength(1);
    expect(secrets.get(added.id)).toBe(token);
    service.updateCredential(added.id, { api_token: "replacement", label: "rotated" });
    expect(secrets.get(added.id)).toBe("replacement");
    expect(JSON.stringify(service.listCredentials())).not.toContain("replacement");
    expect(service.removeCredential(added.id)).toMatchObject({ removed: true });
    expect(() => secrets.get(added.id)).toThrow("Credential secret unavailable");
    db.close();
  });

  it("never returns bearer material embedded in persisted source configuration", () => {
    const h = harness();
    const token = "embedded-bearer-secret";
    const credential = h.service.addCredential({ api_token: token, label: "Fixture key" }) as any;
    h.service.configure({ origin: "https://wormholes.invalid", api_path_prefix: "/api", map_route_key: "id",
      canonical_map_id: h.targetMap, upstream_map_id: "api-map-7", credential_id: credential.id });
    const row = h.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as any;
    const persisted = { ...JSON.parse(row.config_json), origin: `https://${token}.wormholes.invalid` };
    h.db.prepare("UPDATE wormholesystems_config SET config_json=? WHERE id='singleton'").run(JSON.stringify(persisted));

    let configurationError = "";
    try { h.service.configuration(); } catch (error) { configurationError = String(error); }
    let statusError = "";
    try { h.service.status(h.targetMap); } catch (error) { statusError = String(error); }
    const setter = h.service.setMaxStaleness(30_000);
    expect(setter).toMatchObject({ committed: false });
    expect(JSON.stringify({ configurationError, statusError, setter })).not.toContain(token);
    expect(configurationError).toContain("Credential value cannot match");
    expect(statusError).toContain("Credential value cannot match");
    expect(JSON.stringify(setter)).not.toContain(token);
    h.db.close();
  });

  it("migrates the prior permanently-ineligible snapshot constraint without losing rows", () => {
    const db = openStateDatabase(":memory:");
    const store = new NexumStore(db);
    const nexumCredential = { id: "nexum-migration", base_url: "https://nexum.invalid", label: "fixture", enabled: true };
    store.saveCredential(nexumCredential);
    store.discover(nexumCredential, [{ id: "migration-map", name: "Migration" }], nexumCredential.base_url);
    db.exec(`CREATE TABLE wormholesystems_source_snapshots (
      map_id TEXT PRIMARY KEY REFERENCES nexum_maps(id) ON DELETE CASCADE, source_api_map_id TEXT NOT NULL,
      revision_or_digest TEXT NOT NULL, fetched_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      eligible_for_matching INTEGER NOT NULL CHECK(eligible_for_matching=0)
    );`);
    const mapId = store.maps()[0].id;
    db.prepare("INSERT INTO wormholesystems_source_snapshots VALUES (?,?,?,?,?,0)")
      .run(mapId, "source-map", "old-revision", "2026-10-12T00:00:00.000Z", JSON.stringify({ old: true }));
    const service = new WormholeSystemsService(store, { put() {}, get() { return "unused"; }, remove() {} });
    expect(db.prepare("SELECT revision_or_digest,eligible_for_matching FROM wormholesystems_source_snapshots WHERE map_id=?").get(mapId))
      .toMatchObject({ revision_or_digest: "old-revision", eligible_for_matching: 0 });
    expect(() => db.prepare(`UPDATE wormholesystems_source_snapshots SET eligible_for_matching=1 WHERE map_id=?`).run(mapId)).not.toThrow();
    void service;
    db.close();
  });

  it("persists the approved and operator policy across restart, reconfiguration, and source removal", async () => {
    vi.stubEnv("GALAXY_WORMSYSTEMS_MAX_STALENESS_MS", "not-a-number");
    const h = harness();
    expect(h.service.configuration()).toMatchObject({ configured: false,
      staleness_policy: { max_age_ms: 60_000, origin: "approved_default" } });
    expect(h.db.prepare("SELECT count(*) AS n FROM wormholesystems_config").get()).toMatchObject({ n: 0 });
    await configured(h.service, h.targetMap);
    const initial = (h.service.configuration() as any).staleness_policy;
    const sourceConfigurationRevision = JSON.parse((h.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as any).config_json).configurationRevision;
    expect(initial).toMatchObject({ max_age_ms: 60_000, origin: "approved_default" });
    vi.stubEnv("GALAXY_WORMSYSTEMS_MAX_STALENESS_MS", "900000000");
    expect((h.service.configuration() as any).staleness_policy).toEqual(initial);
    const set = h.service.setMaxStaleness(30_000) as any;
    expect(set).toMatchObject({ committed: true, staleness_policy: { max_age_ms: 30_000, origin: "operator" } });
    expect(set.staleness_policy.revision).not.toBe(initial.revision);
    const sameValue = h.service.setMaxStaleness(30_000) as any;
    expect(sameValue.staleness_policy.revision).not.toBe(set.staleness_policy.revision);
    expect(JSON.parse((h.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as any).config_json).configurationRevision)
      .toBe(sourceConfigurationRevision);

    const restarted = new WormholeSystemsService(h.store, h.secrets, fetch,
      () => Date.parse("2026-10-13T12:00:00.000Z"), async () => {}, h.nexumWrites);
    expect(restarted.configuration()).toMatchObject({ staleness_policy: sameValue.staleness_policy });
    await configured(restarted, h.targetMap);
    expect(restarted.configuration()).toMatchObject({ staleness_policy: sameValue.staleness_policy });

    const removed = restarted.removeConfiguration() as any;
    expect(removed).toMatchObject({ configured: false, staleness_policy_reset: true,
      staleness_policy: { max_age_ms: 60_000, origin: "approved_default" } });
    expect(removed.staleness_policy.revision).not.toBe(sameValue.staleness_policy.revision);
    await configured(restarted, h.targetMap);
    expect(restarted.configuration()).toMatchObject({ staleness_policy: removed.staleness_policy });
    h.db.close();
  });

  it("retains valid preexisting policy fields and initializes only a markerless legacy config", async () => {
    const h = harness();
    await configured(h.service, h.targetMap);
    const before = h.service.configuration() as any;
    const row = h.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as any;
    const legacy = JSON.parse(row.config_json);
    delete legacy.max_staleness_ms;
    delete legacy.staleness_policy_origin;
    delete legacy.staleness_policy_revision;
    h.db.prepare("UPDATE wormholesystems_config SET config_json=? WHERE id='singleton'").run(JSON.stringify(legacy));
    h.db.prepare("DELETE FROM wormholesystems_policy_state WHERE id='singleton'").run();
    h.db.prepare(`INSERT INTO wormholesystems_source_snapshots(map_id,source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json,eligible_for_matching,credential_id,credential_version,source_configured_at,source_config_revision)
      VALUES (?,?,?,?,?,?,NULL,?,1,?,?,?,?)`).run(h.targetMap, "legacy-source", "https://legacy.invalid", "legacy-map", "legacy-revision",
      "2026-10-13T12:00:00.000Z", JSON.stringify({ fixture: {} }), legacy.credentialId, 1, legacy.configuredAt, legacy.configurationRevision);
    const migrated = new WormholeSystemsService(h.store, h.secrets, fetch,
      () => Date.parse("2026-10-13T12:00:00.000Z"), async () => {}, h.nexumWrites);
    const migratedConfig = migrated.configuration() as any;
    expect(migratedConfig).toMatchObject({ configured: true, origin: before.origin, canonical_map_id: h.targetMap,
      configured_at: before.configured_at, staleness_policy: { max_age_ms: 60_000, origin: "approved_default" } });
    expect(h.db.prepare("SELECT count(*) AS n,revision_or_digest FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap))
      .toMatchObject({ n: 1, revision_or_digest: "legacy-revision" });

    const operatorRevision = "preserved-operator-revision";
    const currentRow = h.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as any;
    const preexistingOperator = { ...JSON.parse(currentRow.config_json), max_staleness_ms: 12_345,
      staleness_policy_origin: "operator", staleness_policy_revision: operatorRevision };
    h.db.prepare("UPDATE wormholesystems_config SET config_json=? WHERE id='singleton'").run(JSON.stringify(preexistingOperator));
    h.db.prepare("DELETE FROM wormholesystems_policy_state WHERE id='singleton'").run();
    const retained = new WormholeSystemsService(h.store, h.secrets, fetch,
      () => Date.parse("2026-10-13T12:00:00.000Z"), async () => {}, h.nexumWrites);
    expect(retained.configuration()).toMatchObject({ staleness_policy: { max_age_ms: 12_345, origin: "operator", revision: operatorRevision } });
    h.db.close();
  });

  it("rejects invalid setter values, detects post-initialization corruption, and fails busy without commit", async () => {
    const h = harness();
    await configured(h.service, h.targetMap);
    const before = (h.service.configuration() as any).staleness_policy;
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "30000", Infinity, NaN, null, undefined])
      expect(h.service.setMaxStaleness(invalid)).toMatchObject({ committed: false });
    expect((h.service.configuration() as any).staleness_policy).toEqual(before);

    let unlock!: () => void;
    let started!: () => void;
    const acquired = new Promise<void>(resolve => { started = resolve; });
    const active = mapDecisionBoundary.run(h.targetMap, () => {
      started();
      return new Promise<void>(resolve => { unlock = resolve; });
    });
    await acquired;
    const busy = h.service.setMaxStaleness(25_000) as any;
    expect(busy).toMatchObject({ committed: false, retryable: true });
    expect((h.service.configuration() as any).staleness_policy).toEqual(before);
    unlock();
    await active;
    const committed = h.service.setMaxStaleness(25_000) as any;
    expect(committed).toMatchObject({ committed: true, staleness_policy: { max_age_ms: 25_000, origin: "operator" } });

    const configRow = h.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as any;
    const corrupt = { ...JSON.parse(configRow.config_json), max_staleness_ms: 0 };
    h.db.prepare("UPDATE wormholesystems_config SET config_json=? WHERE id='singleton'").run(JSON.stringify(corrupt));
    const restarted = new WormholeSystemsService(h.store, h.secrets, fetch,
      () => Date.parse("2026-10-13T12:00:00.000Z"), async () => {}, h.nexumWrites);
    expect(restarted.configuration()).toMatchObject({ staleness_policy: { max_age_ms: null, origin: "invalid", revision: null },
      activation_blockers: expect.arrayContaining(["invalid_persisted_policy"]) });
    expect(restarted.setMaxStaleness(40_000)).toMatchObject({ committed: false, error: expect.stringContaining("invalid_persisted_policy") });
    expect(JSON.parse((h.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as any).config_json).max_staleness_ms)
      .toBe(0);

    const malformedJson = "{ malformed persisted config";
    h.db.exec("PRAGMA ignore_check_constraints=ON");
    h.db.prepare("UPDATE wormholesystems_config SET config_json=? WHERE id='singleton'").run(malformedJson);
    h.db.exec("PRAGMA ignore_check_constraints=OFF");
    const malformedRestart = new WormholeSystemsService(h.store, h.secrets, fetch,
      () => Date.parse("2026-10-13T12:00:00.000Z"), async () => {}, h.nexumWrites);
    expect(malformedRestart.configuration()).toMatchObject({ configured: false,
      staleness_policy: { max_age_ms: null, origin: "invalid", revision: null },
      source_snapshot_blockers: expect.arrayContaining(["invalid_persisted_policy"]),
      full_matching_blockers: expect.arrayContaining(["invalid_persisted_policy"]) });
    expect(malformedRestart.status(h.targetMap)).toMatchObject({ eligible_for_matching: false,
      source_snapshot_eligible_for_matching: false,
      staleness_policy: { max_age_ms: null, origin: "invalid", revision: null },
      full_matching_blockers: expect.arrayContaining(["invalid_persisted_policy"]) });
    expect(malformedRestart.setMaxStaleness(40_000)).toMatchObject({ committed: false,
      error: expect.stringContaining("invalid_persisted_policy") });
    expect((h.db.prepare("SELECT config_json FROM wormholesystems_config WHERE id='singleton'").get() as any).config_json).toBe(malformedJson);
    h.db.close();
  });

  it("tests accessible map and explicit route choice without returning a bearer", async () => {
    const calls: Array<{ url: string; auth: string | undefined; method: string | undefined }> = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: (init?.headers as Record<string, string>).Authorization, method: init?.method });
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap, "slug");
    const result = await h.service.testConnection();
    expect(result).toMatchObject({ status: "maps_detail_schema_ok", authenticated: true, selected_upstream_map_id: "api-map-7", live_sync_enabled: false });
    expect(h.service.configuration()).toMatchObject({ live_sync_enabled: false, eligible_for_writes: false,
      write_eligibility: { topology: { eligible: false }, alliance_notes: { eligible: false } } });
    expect(h.service.enableSync()).toMatchObject({ live_sync_enabled: true, eligible_for_writes: false });
    expect(h.service.disableSync()).toMatchObject({ live_sync_enabled: false, eligible_for_writes: false });
    expect(calls.map(call => call.url)).toEqual(["https://wormholes.invalid/api/maps", "https://wormholes.invalid/api/maps/api-map-7",
      "https://wormholes.invalid/api/map-solarsystems/map-system-test"]);
    expect(calls.every(call => call.method === "GET" && call.auth === "Bearer token-do-not-echo")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("token-do-not-echo");
    h.db.close();
  });

  it("fails selected-map schema validation when no system exists or selected-system detail is malformed", async () => {
    const empty = harness(vi.fn(async (input: string | URL | Request) => String(input).endsWith("/maps")
      ? response({ data: [{ id: "api-map-7", slug: "api-slug" }] })
      : response({ data: { ...selectedMapDetail(), map_solarsystems: [] } })) as typeof fetch);
    await configured(empty.service, empty.targetMap);
    expect(await empty.service.testConnection()).toMatchObject({ status: "request_failed", live_sync_enabled: false,
      error: "Selected WormholeSystems map has no solar-system records" });
    expect(() => empty.service.enableSync()).toThrow("successful connection and selected-map schema test");

    const invalidDetail = harness(vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response({ data: { id: "map-system-test", solar_system_id: 31_000_001, signatures: [], connections: [] } });
    }) as typeof fetch);
    await configured(invalidDetail.service, invalidDetail.targetMap);
    expect(await invalidDetail.service.testConnection()).toMatchObject({ status: "request_failed", live_sync_enabled: false });
    expect(() => invalidDetail.service.enableSync()).toThrow("successful connection and selected-map schema test");
    empty.db.close(); invalidDetail.db.close();
  });

  it("reports an inaccessible selected map and malformed API shape with sanitized diagnostics", async () => {
    const transport = vi.fn(async () => response({ data: [{ id: "different", slug: "other" }] }));
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    expect(await h.service.testConnection()).toMatchObject({ status: "inaccessible_or_not_listed", authenticated: true, accessible_map_count: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    const malformed = harness(vi.fn(async () => response({ maps: [] })) as typeof fetch);
    await configured(malformed.service, malformed.targetMap);
    expect(await malformed.service.testConnection()).toMatchObject({ status: "request_failed", error: "Malformed WormholeSystems maps response" });
    h.db.close(); malformed.db.close();
  });

  it("invalidates activation when a retest shows that the configured map is no longer in scope", async () => {
    let mapRequests = 0;
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: ++mapRequests === 2 ? [{ id: "other-map", slug: "other" }] : [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    expect(h.service.configuration()).toMatchObject({ live_sync_enabled: true });
    expect(await h.service.testConnection()).toMatchObject({ status: "inaccessible_or_not_listed", live_sync_enabled: false });
    expect(h.service.configuration()).toMatchObject({ live_sync_enabled: false, schema_validated_at: null });
    h.db.close();
  });

  it("does not echo a bearer if an upstream map record unexpectedly contains it", async () => {
    const transport = vi.fn(async () => response({ data: [{ id: "api-map-7", slug: "token-do-not-echo" }] }));
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    const result = await h.service.listAccessibleMaps();
    expect(result).toMatchObject({ status: "request_failed", maps: [], error: "Malformed WormholeSystems maps response" });
    expect(JSON.stringify(result)).not.toContain("token-do-not-echo");
    h.db.close();
  });

  it("requires canonical Nexum map IDs and rejects name-based bindings or status access", async () => {
    const h = harness();
    const credential = h.service.addCredential({ api_token: "canonical-test-token" });
    expect(() => h.service.configure({ origin: "https://wormholes.invalid", api_path_prefix: "/api", map_route_key: "id",
      canonical_map_id: "Target", upstream_map_id: "api-map-7", credential_id: credential.id })).toThrow("canonical map ID");
    await configured(h.service, h.targetMap);
    expect(() => h.service.status("Target")).toThrow("canonical map ID");
    await expect(h.service.syncMap("Target")).rejects.toThrow("canonical map ID");
    h.db.close();
  });

  it("allows short config values inside bearer tokens but rejects exact secret reuse", () => {
    const h = harness();
    const token = "bearer-id-slug-2-/api";
    const credential = h.service.addCredential({ api_token: token, label: "Fixture key" });
    expect(() => h.service.configure({ origin: "https://wormholes.invalid", api_path_prefix: "/api", map_route_key: "id",
      canonical_map_id: h.targetMap, upstream_map_id: "2", credential_id: credential.id })).not.toThrow();
    expect(h.service.configuration()).toMatchObject({ configured: true, map_route_key: "id", upstream_map_id: "2" });

    expect(() => h.service.updateCredential(credential.id, { api_token: "2" })).toThrow("Credential value");
    expect(h.secrets.get(credential.id)).toBe(token);
    expect(() => h.service.addCredential({ api_token: "label-secret", label: "label-secret" })).toThrow("Invalid credential label");
    expect(() => h.service.updateCredential(credential.id, { label: token })).toThrow("Invalid credential label");
    expect(JSON.stringify(h.service.listCredentials())).not.toContain(token);
    expect(JSON.stringify(h.service.configuration())).not.toContain(token);
    h.db.close();
  });

  it("rejects credential collisions with route-key fields and current config during replacement", async () => {
    for (const [route, token] of [["id", "id"], ["slug", "slug"]] as const) {
      const h = harness();
      const collision = h.service.addCredential({ api_token: token });
      expect(() => h.service.configure({ origin: "https://wormholes.invalid", api_path_prefix: "/api", map_route_key: route,
        canonical_map_id: h.targetMap, upstream_map_id: "api-map-7", credential_id: collision.id })).toThrow("Credential value");
      h.db.close();
    }
    const h = harness();
    const credential = h.service.addCredential({ api_token: "initial-safe-token" });
    h.service.configure({ origin: "https://wormholes.invalid", api_path_prefix: "/api", map_route_key: "id",
      canonical_map_id: h.targetMap, upstream_map_id: "api-map-7", credential_id: credential.id });
    const config = h.service.configuration() as any;
    h.db.prepare(`INSERT INTO wormholesystems_source_snapshots(map_id,source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json,eligible_for_matching)
      VALUES (?,?,?,?,?,?,NULL,?,1)`).run(h.targetMap, "wormholesystems:[\"https://wormholes.invalid\",\"api-map-7\"]", "https://wormholes.invalid", "api-map-7", "credential-bound", "2026-10-13T12:00:00.000Z", JSON.stringify({ retained: true }));
    expect(() => h.service.updateCredential(credential.id, { api_token: "id" })).toThrow("Credential value");
    expect(h.secrets.get(credential.id)).toBe("initial-safe-token");
    h.service.updateCredential(credential.id, { api_token: "replacement-safe-token" });
    expect(h.service.configuration()).toMatchObject({ live_sync_enabled: false, schema_validated_at: null });
    expect(h.db.prepare("SELECT eligible_for_matching,payload_json FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap))
      .toMatchObject({ eligible_for_matching: 0, payload_json: JSON.stringify({ retained: true }) });
    expect(config.configured_at).toBeDefined();
    h.db.close();
  });

  it("keeps source sync disabled until explicit activation, preserves a last-good snapshot, and isolates canonical map IDs", async () => {
    const transport = vi.fn(async () => response({ data: [] }));
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    h.db.prepare(`INSERT INTO wormholesystems_source_snapshots(map_id,source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json,eligible_for_matching)
      VALUES (?,?,?,?,?,?,NULL,?,1)`).run(h.targetMap, "wormholesystems:https://wormholes.invalid:api-map-7", "https://wormholes.invalid", "api-map-7", "old-digest", "2026-10-12T00:00:00.000Z", JSON.stringify({ unverified: true }));
    h.service.configure({ origin: "https://wormholes.invalid", api_path_prefix: "/api", map_route_key: "id",
      canonical_map_id: h.targetMap, upstream_map_id: "api-map-7", credential_id: h.service.listCredentials()[0].id });
    expect(h.db.prepare("SELECT eligible_for_matching FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap))
      .toMatchObject({ eligible_for_matching: 0 });
    const before = transport.mock.calls.length;
    expect(await h.service.syncMap(h.targetMap)).toMatchObject({ status: "disabled", fetched: false,
      source_calls: 0, last_good_snapshot_retained: true, revision_or_digest: "old-digest", nexum_writes_attempted: false });
    expect(h.service.preview(h.targetMap).preview).toMatchObject({ local_only: true, upstream_calls: 0, matching_performed: false, writes_enabled: false });
    expect(transport.mock.calls.length).toBe(before);
    expect(h.service.status(h.targetMap)).toMatchObject({ snapshot_present: true, eligible_for_matching: false, eligible_for_writes: false });
    await expect(h.service.syncMap(h.otherMap)).rejects.toThrow("not the explicitly configured canonical map");
    expect(h.db.prepare("SELECT count(*) AS n FROM wormholesystems_source_runs WHERE map_id=?").get(h.otherMap)).toMatchObject({ n: 0 });
    expect(h.db.prepare("SELECT count(*) AS n FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.otherMap)).toMatchObject({ n: 0 });
    expect(transport.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method !== "PATCH")).toBe(true);
    expect(h.service.removeConfiguration()).toMatchObject({ configured: false, live_sync_enabled: false });
    expect(h.service.listCredentials()).toHaveLength(1);
    expect(h.db.prepare("SELECT count(*) AS n FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap)).toMatchObject({ n: 1 });
    h.db.close();
  });

  it("stores a full validated snapshot and blocks data writes until a Nexum writer is explicitly bound", async () => {
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap, "slug");
    await enableAfterTest(h.service);
    h.db.prepare(`INSERT INTO wormholesystems_source_snapshots(map_id,source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json,eligible_for_matching)
      VALUES (?,?,?,?,?,?,NULL,?,0)`).run(h.targetMap, "old-source", "https://old.invalid", "old-map", "old-digest", "2026-10-12T00:00:00.000Z", JSON.stringify({ old: true }));
    const result = await h.service.syncMap(h.targetMap);
    expect(result).toMatchObject({ status: "snapshot_validated", fetched: true, source_calls: 3,
      source_api_map_id: "api-map-7", systemCount: 1, snapshot_stored: true,
      linked_note_writes_attempted: false, nexum_writes_attempted: false,
      topology_sync: { status: "blocked", attempted: false,
        blockers: expect.arrayContaining(["an explicit Nexum topology writer key has not been selected"]) } });
    const stored = h.db.prepare("SELECT * FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap) as any;
    expect(stored.source_api_map_id).toBe("api-map-7");
    expect(stored.revision_or_digest).toBe(result.revision_or_digest);
    expect(stored.revision_or_digest).not.toBe("old-digest");
    expect(stored.eligible_for_matching).toBe(1);
    expect(JSON.parse(stored.payload_json)).toMatchObject({ schema: "wormholesystems-source-v3", adapterVersion: 3,
      fixture: { sourceKind: "wormholesystems", schemaVersion: 3, sourceSignatureEvidence: [],
        scope: { canonicalMapId: h.targetMap }, systems: [{ eveSolarSystemId: 31_000_001 }], signatures: [], connections: [] } });
    expect(transport.mock.calls.map(call => (call[1] as RequestInit).method)).toEqual(["GET", "GET", "GET", "GET", "GET", "GET"]);
    expect(transport.mock.calls.every(call => (call[1] as RequestInit).method !== "PATCH")).toBe(true);
    expect(h.nexumWrites.writeWormholesystemsTopology).not.toHaveBeenCalled();
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes).not.toHaveBeenCalled();
    h.service.disableSync();
    expect(h.db.prepare("SELECT count(*) AS n,eligible_for_matching FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap))
      .toMatchObject({ n: 1, eligible_for_matching: 0 });
    h.service.enableSync();
    expect(h.service.preview(h.targetMap).preview).toMatchObject({ snapshot_eligible_for_matching: false });
    h.service.removeConfiguration();
    expect(h.db.prepare("SELECT count(*) AS n,eligible_for_matching FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap))
      .toMatchObject({ n: 1, eligible_for_matching: 0 });
    h.db.close();
  });

  it("fetches and PUTs the complete v2 snapshot in the same sync, including an unconnected unassigned signature", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const mapDetail = { ...selectedMapDetail(), map_solarsystems: [{ id: "map-system-test", map_id: "api-map-7",
      solarsystem_id: 31_000_001, position: { x: 12, y: 34 } }] };
    const detail = systemDetail("map-system-test", 31_000_001, [{ id: "source-signature-1", signature_id: null,
      map_solarsystem_id: "map-system-test", signature_type_id: null, signature_category_id: null, wormhole_id: null,
      wormhole: { id: null, name: null, leads_to: "must-not-be-used" } }]);
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      return response(detail);
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    const binding = h.service.bindNexumTopologyWriter("nexum-test", true);
    expect(binding).toMatchObject({ bound: true, canonical_map_id: h.targetMap, nexum_map_id: "target-map", topology_schema_version: 2 });
    h.nexumWrites.writeWormholesystemsTopology.mockResolvedValue({
      createdSystems: 1, updatedSystems: 0, preservedSystems: 0, deletedSystems: 0,
      createdConnections: 0, updatedConnections: 0, preservedConnections: 0, deletedConnections: 0,
      createdSignatures: 1, updatedSignatures: 0, preservedSignatures: 0, deletedSignatures: 0, conflicts: [],
      checkpoint: { accepted: true, replayed: false, partial: false },
    } as any);

    const sync = await h.service.syncMap(h.targetMap) as any;
    expect(sync).toMatchObject({ status: "snapshot_validated", fetched: true, source_calls: 3,
      nexum_writes_attempted: true, linked_note_writes_attempted: false,
      topology_sync: { status: "succeeded", attempted: true,
        reconciliation: { reconciliation_status: "applied", created_signatures: 1 } } });
    expect(h.nexumWrites.writeWormholesystemsTopology).toHaveBeenCalledTimes(1);
    const [canonicalId, request, writerId, bindingArgs] = h.nexumWrites.writeWormholesystemsTopology.mock.calls[0] as any;
    expect(canonicalId).toBe(h.targetMap);
    expect(writerId).toBe("nexum-test");
    expect(bindingArgs).toEqual({ baseUrl: "https://nexum.invalid", nexumMapId: "target-map" });
    expect(request).toMatchObject({ schemaVersion: 2,
      sourceIdentity: 'wormholesystems:["https://wormholes.invalid","api-map-7"]',
      snapshot: { complete: true, fetchedAt: sync.fetched_at },
      systems: [{ sourceSystemId: "map-system-test", eveSystemId: 31_000_001, positionX: 12, positionY: 34 }],
      connections: [],
      signatures: [{ sourceSignatureId: "source-signature-1", sourceSystemId: "map-system-test", sourceConnectionId: null,
        sigId: "", sigType: "unknown", whType: "" }] });
    expect(Object.isFrozen(request)).toBe(true);
    expect(JSON.stringify(request)).not.toContain("must-not-be-used");
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes).not.toHaveBeenCalled();
    const upstreamCalls = transport.mock.calls.length;
    h.service.preview(h.targetMap);
    expect(transport).toHaveBeenCalledTimes(upstreamCalls);
    expect(h.nexumWrites.writeWormholesystemsTopology).toHaveBeenCalledTimes(1);
    h.db.close();
  });

  it("reports an incomplete acknowledgement when a successful PUT response lacks a valid checkpoint", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.service.bindNexumTopologyWriter("nexum-test", true);
    const counters = { createdSystems: 0, updatedSystems: 0, preservedSystems: 0, deletedSystems: 0,
      createdConnections: 0, updatedConnections: 0, preservedConnections: 0, deletedConnections: 0,
      createdSignatures: 0, updatedSignatures: 0, preservedSignatures: 0, deletedSignatures: 0, conflicts: [] };
    h.nexumWrites.writeWormholesystemsTopology.mockResolvedValueOnce(counters as any)
      .mockResolvedValueOnce({ ...counters, checkpoint: { accepted: "yes", replayed: false, partial: false } } as any)
      .mockResolvedValueOnce({ ...counters, checkpoint: { accepted: true } } as any)
      .mockResolvedValueOnce({ ...counters, checkpoint: { accepted: false, replayed: true, partial: false } } as any);

    const missing = await h.service.syncMap(h.targetMap) as any;
    expect(missing.topology_sync).toMatchObject({ status: "acknowledged_result_incomplete", attempted: true,
      accepted: null, reconciliation: { reconciliation_status: "unknown", checkpoint: null } });
    const malformed = await h.service.syncMap(h.targetMap) as any;
    expect(malformed.topology_sync).toMatchObject({ status: "acknowledged_result_incomplete", attempted: true,
      accepted: null, reconciliation: { reconciliation_status: "unknown", checkpoint: null } });
    const missingPartial = await h.service.syncMap(h.targetMap) as any;
    expect(missingPartial.topology_sync).toMatchObject({ status: "acknowledged_result_incomplete", attempted: true,
      accepted: null, reconciliation: { reconciliation_status: "unknown", checkpoint: null } });
    const replayed = await h.service.syncMap(h.targetMap) as any;
    expect(replayed.topology_sync).toMatchObject({ status: "succeeded", attempted: true, accepted: true,
      reconciliation: { reconciliation_status: "unchanged", checkpoint: { accepted: false, replayed: true, partial: false } } });
    expect(h.nexumWrites.writeWormholesystemsTopology).toHaveBeenCalledTimes(4);
    h.db.close();
  });

  it("uses a valid selected-system position when the map member has no position", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const mapDetail = selectedMapDetail();
    const detail = { ...testSystemDetail(), data: { ...testSystemDetail().data, position: { x: 12, y: 34 } } };
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      return response(detail);
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.service.bindNexumTopologyWriter("nexum-test", true);
    h.nexumWrites.writeWormholesystemsTopology.mockResolvedValue({
      createdSystems: 1, updatedSystems: 0, preservedSystems: 0, deletedSystems: 0,
      createdConnections: 0, updatedConnections: 0, preservedConnections: 0, deletedConnections: 0,
      createdSignatures: 0, updatedSignatures: 0, preservedSignatures: 0, deletedSignatures: 0, conflicts: [],
      checkpoint: { accepted: true, replayed: false, partial: false },
    } as any);

    const result = await h.service.syncMap(h.targetMap) as any;
    expect(result.topology_sync).toMatchObject({ status: "succeeded", attempted: true });
    const request = h.nexumWrites.writeWormholesystemsTopology.mock.calls[0][1] as any;
    expect(request.systems).toEqual([{ sourceSystemId: "map-system-test", eveSystemId: 31_000_001, positionX: 12, positionY: 34 }]);
    h.db.close();
  });

  it("replays the identical frozen request after a lost response and refetches after its freshness deadline", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const initialNow = Date.parse("2026-10-13T12:00:00.000Z");
    let now = initialNow;
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch, undefined, undefined, () => true, () => now);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.service.bindNexumTopologyWriter("nexum-test", true);
    const counters = { createdSystems: 1, updatedSystems: 0, preservedSystems: 0, deletedSystems: 0,
      createdConnections: 0, updatedConnections: 0, preservedConnections: 0, deletedConnections: 0,
      createdSignatures: 0, updatedSignatures: 0, preservedSignatures: 0, deletedSignatures: 0, conflicts: [] };
    h.nexumWrites.writeWormholesystemsTopology.mockRejectedValueOnce(new Error("simulated lost PUT response"))
      .mockRejectedValueOnce(new Error("simulated repeated lost PUT response"))
      .mockResolvedValueOnce({ ...counters, checkpoint: { accepted: true, replayed: false, partial: false } } as any);

    const first = await h.service.syncMap(h.targetMap) as any;
    expect(first.topology_sync).toMatchObject({ status: "indeterminate", attempted: true, indeterminate: true });
    const firstRequest = h.nexumWrites.writeWormholesystemsTopology.mock.calls[0][1] as any;
    const firstBytes = JSON.stringify(firstRequest);
    const sourceCallsAfterInitialFetch = transport.mock.calls.length;

    now = initialNow + 30_000;
    const replay = await h.service.syncMap(h.targetMap) as any;
    expect(replay).toMatchObject({ status: "snapshot_validated", fetched: false, source_calls: 0,
      topology_sync: { status: "indeterminate", attempted: true, indeterminate: true } });
    expect(transport).toHaveBeenCalledTimes(sourceCallsAfterInitialFetch);
    const replayRequest = h.nexumWrites.writeWormholesystemsTopology.mock.calls[1][1] as any;
    expect(replayRequest).toEqual(firstRequest);
    expect(JSON.stringify(replayRequest)).toBe(firstBytes);

    now = initialNow + 60_001;
    const refreshed = await h.service.syncMap(h.targetMap) as any;
    expect(refreshed).toMatchObject({ status: "snapshot_validated", fetched: true, source_calls: 3,
      topology_sync: { status: "succeeded", attempted: true } });
    expect(transport).toHaveBeenCalledTimes(sourceCallsAfterInitialFetch + 3);
    const freshRequest = h.nexumWrites.writeWormholesystemsTopology.mock.calls[2][1] as any;
    expect(freshRequest.snapshot.fetchedAt).toBe(new Date(now).toISOString());
    expect(JSON.stringify(freshRequest)).not.toBe(firstBytes);
    expect(JSON.stringify({ first, replay, refreshed })).not.toContain("simulated lost PUT response");
    h.db.close();
  });

  it("PUTs a complete snapshot with unknown classification when source scalars are unmapped", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const mapDetail = { ...selectedMapDetail(), map_solarsystems: [{ id: "map-system-test", map_id: "api-map-7",
      solarsystem_id: 31_000_001, position: { x: 12, y: 34 } }] };
    const detail = systemDetail("map-system-test", 31_000_001, [{ id: "source-signature-1", signature_id: "QRS-123",
      map_solarsystem_id: "map-system-test", signature_type_id: 197, signature_category_id: 1, wormhole_id: null,
      wormhole: { id: null, name: "B274" } }]);
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      return response(detail);
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.service.bindNexumTopologyWriter("nexum-test", true);
    h.nexumWrites.writeWormholesystemsTopology.mockResolvedValue({
      createdSystems: 1, updatedSystems: 0, preservedSystems: 0, deletedSystems: 0,
      createdConnections: 0, updatedConnections: 0, preservedConnections: 0, deletedConnections: 0,
      createdSignatures: 1, updatedSignatures: 0, preservedSignatures: 0, deletedSignatures: 0, conflicts: [],
      checkpoint: { accepted: true, replayed: false, partial: false },
    } as any);
    const sync = await h.service.syncMap(h.targetMap) as any;
    expect(sync).toMatchObject({ status: "snapshot_validated", fetched: true, nexum_writes_attempted: true,
      topology_sync: { status: "succeeded", attempted: true, diagnostics: [
        'signatures[source-signature-1]: source category is absent or unsupported; projected as sigType "unknown" with empty whType (type_unmapped)',
      ] } });
    expect(h.nexumWrites.writeWormholesystemsTopology).toHaveBeenCalledTimes(1);
    const request = h.nexumWrites.writeWormholesystemsTopology.mock.calls[0][1] as any;
    expect(request.signatures).toEqual([{ sourceSignatureId: "source-signature-1", sourceSystemId: "map-system-test",
      sourceConnectionId: null, sigId: "QRS-123", sigType: "unknown", whType: "" }]);
    expect(h.db.prepare("SELECT eligible_for_matching FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap))
      .toMatchObject({ eligible_for_matching: 1 });
    h.db.close();
  });

  it("projects a validated WormholeSystems wormhole relation using its exact name", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const mapDetail = { ...selectedMapDetail(), map_solarsystems: [{ id: "map-system-test", map_id: "api-map-7",
      solarsystem_id: 31_000_001, position: { x: 12, y: 34 } }] };
    const detail = systemDetail("map-system-test", 31_000_001, [{ id: "source-signature-bcm-579", signature_id: "BCM-579",
      map_solarsystem_id: "map-system-test", signature_type_id: 197, signature_category_id: 1,
      signature_category: { id: 1, name: "Wormhole" }, signature_type: { id: 197, signature_category_id: 1 }, wormhole_id: 26,
      wormhole: { id: 26, name: "B274" } }]);
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      return response(detail);
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.service.bindNexumTopologyWriter("nexum-test", true);
    h.nexumWrites.writeWormholesystemsTopology.mockResolvedValue({
      createdSystems: 1, updatedSystems: 0, preservedSystems: 0, deletedSystems: 0,
      createdConnections: 0, updatedConnections: 0, preservedConnections: 0, deletedConnections: 0,
      createdSignatures: 1, updatedSignatures: 0, preservedSignatures: 0, deletedSignatures: 0, conflicts: [],
      checkpoint: { accepted: true, replayed: false, partial: false },
    } as any);

    const sync = await h.service.syncMap(h.targetMap) as any;
    expect(sync).toMatchObject({ status: "snapshot_validated", nexum_writes_attempted: true,
      topology_sync: { status: "succeeded", attempted: true } });
    const request = h.nexumWrites.writeWormholesystemsTopology.mock.calls[0][1] as any;
    expect(request.signatures).toEqual([{ sourceSignatureId: "source-signature-bcm-579", sourceSystemId: "map-system-test",
      sourceConnectionId: null, sigId: "BCM-579", sigType: "wormhole", whType: "B274" }]);
    h.db.close();
  });

  it("blocks a name-only wormhole classification before Nexum writes or checkpoint/deletion effects", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const mapDetail = { ...selectedMapDetail(), map_solarsystems: [{ id: "map-system-test", map_id: "api-map-7",
      solarsystem_id: 31_000_001, position: { x: 12, y: 34 } }] };
    const detail = systemDetail("map-system-test", 31_000_001, [{ id: "source-signature-name-only", signature_id: "BGT-001",
      map_solarsystem_id: "map-system-test", signature_category_id: 1,
      signature_category: { id: 1, name: "Wormhole" }, wormhole: { name: "B274" } }]);
    let currentDetail: unknown = testSystemDetail();
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      return response(currentDetail);
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    currentDetail = detail;
    h.service.bindNexumTopologyWriter("nexum-test", true);
    const previouslyOwnedSignatures = new Set(["previously-owned-signature"]);
    let mockCheckpoint: unknown = { revision: "previously-accepted-snapshot" };
    h.nexumWrites.writeWormholesystemsTopology.mockImplementation(async (_map, request) => {
      previouslyOwnedSignatures.clear();
      for (const signature of (request as any).signatures) previouslyOwnedSignatures.add(signature.sourceSignatureId);
      mockCheckpoint = (request as any).snapshot.fetchedAt;
      return { checkpoint: { accepted: true, replayed: false, partial: false } } as any;
    });
    const checkpointBefore = mockCheckpoint;

    const sync = await h.service.syncMap(h.targetMap) as any;
    expect(sync.topology_sync).toMatchObject({ status: "blocked", attempted: false, accepted: false,
      blockers: expect.arrayContaining([
        "signatures[source-signature-name-only].wormhole_id: Wormhole classification has a partial or contradictory relation/name",
      ]) });
    expect(h.nexumWrites.writeWormholesystemsTopology).not.toHaveBeenCalled();
    expect([...previouslyOwnedSignatures]).toEqual(["previously-owned-signature"]);
    expect(mockCheckpoint).toBe(checkpointBefore);
    h.db.close();
  });

  it("sends every source signature, connection link, and system in the same complete snapshot sync", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const edge = { id: "source-edge", from_map_solarsystem_id: "map-system-a", to_map_solarsystem_id: "map-system-b",
      type: "wormhole", ship_size: "medium", signatures: [
        { id: "source-signature-a", signature_id: "BCM-579", map_solarsystem_id: "map-system-a" },
        { id: "source-signature-b", signature_id: "DEF-456", map_solarsystem_id: "map-system-b" },
      ] };
    const mapDetail = { ...selectedMapDetail(), map_solarsystems: [
      { id: "map-system-a", map_id: "api-map-7", solarsystem_id: 31_000_001, position: { x: 12, y: 34 } },
      { id: "map-system-b", map_id: "api-map-7", solarsystem_id: 31_000_002, position: { x: 56, y: 78 } },
    ], map_connections: [edge] };
    const detailFor = (id: string, eveId: number, signatures: unknown[]) => ({ data: { id, map_id: "api-map-7",
      solarsystem_id: eveId, signatures, map_connections: [edge], audits: [] } });
    const detailA = detailFor("map-system-a", 31_000_001, [
      { id: "source-signature-a", signature_id: "BCM-579", map_solarsystem_id: "map-system-a", map_connection_id: "source-edge",
        map_connection: { id: "source-edge" }, signature_category_id: 1, signature_category: { id: 1, name: "Wormhole" },
        signature_type_id: 197, signature_type: { id: 197, signature_category_id: 1 }, wormhole_id: 26, wormhole: { id: 26, name: "B274" } },
      { id: "source-signature-unassigned", signature_id: null, map_solarsystem_id: "map-system-a", map_connection_id: null },
    ]);
    const detailB = detailFor("map-system-b", 31_000_002, [
      { id: "source-signature-b", signature_id: "DEF-456", map_solarsystem_id: "map-system-b", map_connection_id: "source-edge",
        map_connection: { id: "source-edge" }, signature_category_id: 1, signature_category: { id: 1, name: "Wormhole" },
        signature_type_id: 197, signature_type: { id: 197, signature_category_id: 1 },
        wormhole_id: "wormhole-27", wormhole: { id: "wormhole-27" } },
    ]);
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      if (url.endsWith("/map-solarsystems/map-system-a")) return response(detailA);
      if (url.endsWith("/map-solarsystems/map-system-b")) return response(detailB);
      throw new Error("Unexpected source route");
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.service.bindNexumTopologyWriter("nexum-test", true);
    h.nexumWrites.writeWormholesystemsTopology.mockResolvedValue({
      createdSystems: 2, updatedSystems: 0, preservedSystems: 0, deletedSystems: 0,
      createdConnections: 1, updatedConnections: 0, preservedConnections: 0, deletedConnections: 0,
      createdSignatures: 3, updatedSignatures: 0, preservedSignatures: 0, deletedSignatures: 0, conflicts: [],
      checkpoint: { accepted: true, replayed: false, partial: false },
    } as any);

    const sync = await h.service.syncMap(h.targetMap) as any;
    expect(sync).toMatchObject({ status: "snapshot_validated", fetched: true, source_calls: 4,
      nexum_writes_attempted: true, topology_sync: { status: "succeeded", attempted: true } });
    expect(h.nexumWrites.writeWormholesystemsTopology).toHaveBeenCalledTimes(1);
    const request = h.nexumWrites.writeWormholesystemsTopology.mock.calls[0][1] as any;
    expect(request.systems).toEqual([
      { sourceSystemId: "map-system-a", eveSystemId: 31_000_001, positionX: 12, positionY: 34 },
      { sourceSystemId: "map-system-b", eveSystemId: 31_000_002, positionX: 56, positionY: 78 },
    ]);
    expect(request.connections).toEqual([{ sourceConnectionId: "source-edge", fromSourceSystemId: "map-system-a",
      toSourceSystemId: "map-system-b", sourceSignatureId: "source-signature-a", targetSignatureId: "source-signature-b",
      connection_type: "standard", ship_size: "medium" }]);
    expect(request.signatures).toEqual([
      { sourceSignatureId: "source-signature-a", sourceSystemId: "map-system-a", sourceConnectionId: "source-edge",
        sigId: "BCM-579", sigType: "wormhole", whType: "B274" },
      { sourceSignatureId: "source-signature-b", sourceSystemId: "map-system-b", sourceConnectionId: "source-edge",
        sigId: "DEF-456", sigType: "wormhole", whType: "" },
      { sourceSignatureId: "source-signature-unassigned", sourceSystemId: "map-system-a", sourceConnectionId: null,
        sigId: "", sigType: "unknown", whType: "" },
    ]);
    expect(sync.topology_sync.diagnostics).toContain(
      "signatures[source-signature-b]: validated Wormhole category has no non-empty related name; projected with empty whType");
    h.db.close();
  });

  it("blocks the complete write when one source edge is unsupported and another previously-owned edge is absent", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const members = [
      { id: "map-system-a", map_id: "api-map-7", solarsystem_id: 31_000_001 },
      { id: "map-system-b", map_id: "api-map-7", solarsystem_id: 31_000_002 },
    ];
    const unsupportedEdge = { id: "source-edge-unsupported", from_map_solarsystem_id: "map-system-a",
      to_map_solarsystem_id: "map-system-b", type: "unsupported-type", ship_size: "medium", signatures: [] };
    const mapDetail = { ...selectedMapDetail(), map_solarsystems: members, map_connections: [unsupportedEdge] };
    const detailFor = (id: string, eveId: number) => ({ data: { id, map_id: "api-map-7", solarsystem_id: eveId,
      signatures: [], map_connections: [unsupportedEdge], audits: [] } });
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      if (url.endsWith("/map-solarsystems/map-system-a")) return response(detailFor("map-system-a", 31_000_001));
      if (url.endsWith("/map-solarsystems/map-system-b")) return response(detailFor("map-system-b", 31_000_002));
      throw new Error("Unexpected source route");
    });
    const previouslyOwnedEdges = new Set(["previously-owned-edge"]);
    let mockCheckpoint: unknown = { revision: "previously-accepted-snapshot" };
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.service.bindNexumTopologyWriter("nexum-test", true);
    h.nexumWrites.writeWormholesystemsTopology.mockImplementation(async (_map, request) => {
      previouslyOwnedEdges.clear();
      for (const connection of (request as any).connections) previouslyOwnedEdges.add(connection.sourceConnectionId);
      mockCheckpoint = (request as any).snapshot.fetchedAt;
      return { checkpoint: { accepted: true, replayed: false, partial: false } } as any;
    });
    const checkpointBefore = mockCheckpoint;

    const sync = await h.service.syncMap(h.targetMap) as any;
    expect(sync.topology_sync).toMatchObject({ status: "blocked", attempted: false, accepted: false,
      blockers: expect.arrayContaining(["connections[source-edge-unsupported].type: unsupported source-present connection type cannot be projected"]) });
    expect(h.nexumWrites.writeWormholesystemsTopology).not.toHaveBeenCalled();
    expect([...previouslyOwnedEdges]).toEqual(["previously-owned-edge"]);
    expect(mockCheckpoint).toBe(checkpointBefore);
    expect(sync.topology_sync).not.toHaveProperty("reconciliation");
    h.db.close();
  });

  it("blocks the topology PUT and preview eligibility when a source system is absent from the canonical SDE", async () => {
    vi.stubEnv("NEXUM_BASE_URL", "https://nexum.invalid");
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch, undefined, undefined, () => false);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.service.bindNexumTopologyWriter("nexum-test", true);

    const sync = await h.service.syncMap(h.targetMap) as any;
    expect(sync.topology_sync).toMatchObject({ status: "blocked", attempted: false,
      blockers: expect.arrayContaining(["systems[0].eveSystemId: canonical SDE solar-system identity is unavailable"]) });
    expect(h.nexumWrites.writeWormholesystemsTopology).not.toHaveBeenCalled();
    expect((h.service.preview(h.targetMap) as any).preview.topology_apply).toMatchObject({ eligible: false,
      blockers: expect.arrayContaining(["systems[0].eveSystemId: canonical SDE solar-system identity is unavailable"]) });
    h.db.close();
  });

  it("evaluates source and Nexum freshness at the inclusive policy boundary and immediately after changes", async () => {
    vi.stubEnv("GALAXY_WORMSYSTEMS_MAX_STALENESS_MS", "900000000");
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.store.patchMap(h.targetMap, { health: "live", hydrated_at: now });
    h.store.saveState(h.targetMap, { systems: [{ id: "nexum-system", eveSystemId: 31_000_001 }], connections: [], routes: [] } as any);
    h.store.saveResource(h.targetMap, "nexum-system", "signatures", []);
    await h.service.syncMap(h.targetMap);

    const setAge = (ageMs: number) => {
      const fetchedAt = new Date(now - ageMs).toISOString();
      const row = h.db.prepare("SELECT payload_json FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap) as any;
      const payload = JSON.parse(row.payload_json);
      payload.fixture.fetchedAt = fetchedAt;
      h.db.prepare("UPDATE wormholesystems_source_snapshots SET fetched_at=?,payload_json=? WHERE map_id=?")
        .run(fetchedAt, JSON.stringify(payload), h.targetMap);
      h.store.patchMap(h.targetMap, { hydrated_at: now - ageMs });
      h.db.prepare("UPDATE nexum_resources SET fetched_at=? WHERE map_id=? AND system_id=? AND kind='signatures'")
        .run(now - ageMs, h.targetMap, "nexum-system");
    };
    setAge(60_000);
    expect(h.service.status(h.targetMap)).toMatchObject({ stored_snapshot_eligible_for_matching: true,
      source_snapshot_eligible_for_matching: true, eligible_for_matching: true,
      staleness_policy: { max_age_ms: 60_000, origin: "approved_default" } });

    setAge(60_001);
    expect(h.service.status(h.targetMap)).toMatchObject({ stored_snapshot_eligible_for_matching: true,
      source_snapshot_eligible_for_matching: false, eligible_for_matching: false,
      source_snapshot_blockers: expect.arrayContaining(["source snapshot exceeds the configured maximum matching staleness"]) });
    expect(h.service.setMaxStaleness(100_000)).toMatchObject({ committed: true });
    expect(h.service.status(h.targetMap)).toMatchObject({ stored_snapshot_eligible_for_matching: true,
      source_snapshot_eligible_for_matching: true, eligible_for_matching: true });
    expect(h.service.setMaxStaleness(30_000)).toMatchObject({ committed: true });
    expect(h.service.status(h.targetMap)).toMatchObject({ stored_snapshot_eligible_for_matching: true,
      source_snapshot_eligible_for_matching: false, eligible_for_matching: false });
    expect((h.db.prepare("SELECT eligible_for_matching FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap) as any)
      .eligible_for_matching).toBe(1);

    expect(h.service.setMaxStaleness(100_000)).toMatchObject({ committed: true });
    setAge(0);
    h.db.prepare("DELETE FROM nexum_resources WHERE map_id=? AND system_id=? AND kind='signatures'").run(h.targetMap, "nexum-system");
    expect(h.service.status(h.targetMap)).toMatchObject({ source_snapshot_eligible_for_matching: true, eligible_for_matching: false,
      matching_blockers: expect.arrayContaining(["Nexum signature cache is missing, future-dated or exceeds the configured maximum staleness"]) });
    h.store.saveResource(h.targetMap, "nexum-system", "signatures", []);
    expect(h.service.setMaxStaleness(60_000)).toMatchObject({ committed: true });
    h.db.prepare("UPDATE nexum_resources SET fetched_at=? WHERE map_id=? AND system_id=? AND kind='signatures'")
      .run(now - 60_001, h.targetMap, "nexum-system");
    expect(h.service.status(h.targetMap)).toMatchObject({ source_snapshot_eligible_for_matching: true, eligible_for_matching: false,
      matching_blockers: expect.arrayContaining(["Nexum signature cache is missing, future-dated or exceeds the configured maximum staleness"]) });
    h.db.prepare("UPDATE nexum_resources SET fetched_at=? WHERE map_id=? AND system_id=? AND kind='signatures'")
      .run(now - 60_000, h.targetMap, "nexum-system");
    expect(h.service.status(h.targetMap)).toMatchObject({ source_snapshot_eligible_for_matching: true, eligible_for_matching: true });
    h.store.patchMap(h.targetMap, { hydrated_at: now + 1 });
    expect(h.service.status(h.targetMap)).toMatchObject({ source_snapshot_eligible_for_matching: true, eligible_for_matching: false,
      matching_blockers: expect.arrayContaining(["Nexum map cache is not live or exceeds the configured maximum staleness"]) });
    h.store.patchMap(h.targetMap, { hydrated_at: now });
    h.db.prepare("UPDATE nexum_resources SET fetched_at=? WHERE map_id=? AND system_id=? AND kind='signatures'")
      .run(now + 1, h.targetMap, "nexum-system");
    expect(h.service.status(h.targetMap)).toMatchObject({ source_snapshot_eligible_for_matching: true, eligible_for_matching: false,
      matching_blockers: expect.arrayContaining(["Nexum signature cache is missing, future-dated or exceeds the configured maximum staleness"]) });
    h.db.prepare("UPDATE nexum_resources SET fetched_at=? WHERE map_id=? AND system_id=? AND kind='signatures'")
      .run(now, h.targetMap, "nexum-system");
    setAge(-1);
    expect(h.service.status(h.targetMap)).toMatchObject({ source_snapshot_eligible_for_matching: false, eligible_for_matching: false,
      source_snapshot_blockers: expect.arrayContaining(["source snapshot fetch time is missing or future-dated"]) });
    h.db.close();
  });

  it("reports bounded local-only unmatched diagnostics for every unconnected signature", async () => {
    const systems = Array.from({ length: 12 }, (_, index) => ({ id: `map-system-${index}`, map_id: "api-map-7", solarsystem_id: 31_000_001 + index }));
    const detail = { id: "api-map-7", slug: "api-slug", map_solarsystems: systems, map_connections: [] };
    const details = new Map(systems.map((system, index) => [system.id, { data: { id: system.id, map_id: "api-map-7",
      solarsystem_id: system.solarsystem_id, signatures: [{ id: `source-signature-${index}`,
        signature_id: index === 0 ? "RZQ-108" : index === 1 ? "VGC-572" : `X${String(index).padStart(2, "0")}-A${String(index).padStart(2, "0")}`,
        map_solarsystem_id: system.id,
        ...(index === 0 ? { signature_type_id: "synthetic-type-id", signature_type: { id: "synthetic-type-id", signature_category_id: null },
          signature_category_id: null, signature_category: { id: null, name: "Homefront Operations" },
          wormhole_id: "synthetic-wormhole-id", wormhole: { id: "synthetic-wormhole-id", name: "synthetic-label-not-a-wh-code",
            leads_to: "private-leads-to-do-not-output" }, notes: "private-note-do-not-output" } : {}),
        ...(index === 2 ? { signature_type_id: null, signature_type: { id: null, signature_category_id: null },
          signature_category_id: null, signature_category: { id: null, name: null }, wormhole_id: null,
          wormhole: { id: null, name: null } } : {}) }], map_connections: [], audits: [] } }]));
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: detail });
      const systemId = decodeURIComponent(url.split("/").pop()!);
      return response(details.get(systemId));
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    const sync = await h.service.syncMap(h.targetMap) as any;
    expect(sync).toMatchObject({ status: "snapshot_validated", nexum_writes_attempted: false,
      topology_sync: { status: "blocked", attempted: false },
      staleness_policy: { max_age_ms: 60_000, origin: "approved_default" } });
    const callsAfterFetch = transport.mock.calls.length;
    const preview = h.service.preview(h.targetMap) as any;
    const diagnostics = preview.preview.unmatched.filter((row: any) => row.reason === "no_source_connection_reference");
    expect(diagnostics).toHaveLength(12);
    expect(diagnostics.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_signature_id: "source-signature-0", scanner_eve_system_id: 31_000_001, signature_code: "RZQ-108" }),
      expect.objectContaining({ source_signature_id: "source-signature-1", scanner_eve_system_id: 31_000_002, signature_code: "VGC-572" }),
    ]));
    expect(preview.preview.source_signature_classification).toMatchObject({ status: "captured", total: 12, omitted: 0 });
    const evidence = preview.preview.source_signature_classification.signatures;
    expect(evidence.find((row: any) => row.signature_code === "RZQ-108")).toMatchObject({
      source_signature_id: "source-signature-0", scanner_eve_system_id: 31_000_001,
      signature_type_id: "synthetic-type-id", signature_category_id: null, signature_category_name: "Homefront Operations",
      signature_category_name_status: "source_value", nested_signature_category_id: null, nested_signature_type_id: "synthetic-type-id",
      signature_type_category_id: null, wormhole_id: "synthetic-wormhole-id",
      nested_wormhole_id: "synthetic-wormhole-id", wormhole_name: "synthetic-label-not-a-wh-code",
    });
    const absent = evidence.find((row: any) => row.signature_code === "VGC-572");
    expect(absent).toMatchObject({ source_signature_id: "source-signature-1", classification_status: "captured",
      signature_category_name_status: "source_absent" });
    expect(absent).not.toHaveProperty("signature_type_id");
    expect(absent).not.toHaveProperty("signature_category_id");
    expect(absent).not.toHaveProperty("wormhole_id");
    expect(evidence.find((row: any) => row.source_signature_id === "source-signature-2")).toMatchObject({
      signature_type_id: null, signature_category_id: null, wormhole_id: null, nested_wormhole_id: null, wormhole_name: null,
      signature_category_name: null, signature_category_name_status: "source_null", nested_signature_category_id: null,
      nested_signature_type_id: null, signature_type_category_id: null,
    });
    expect(preview.preview).toMatchObject({ matched: [], writes_enabled: false, nexum_writes_attempted: false });
    expect(preview.preview.alliance_notes).toEqual([]);
    expect(h.nexumWrites.writeWormholesystemsTopology).not.toHaveBeenCalled();
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes).not.toHaveBeenCalled();
    expect(diagnostics.every((row: any) => !("endpoint" in row) && !("desired_note" in row) && !("topology" in row))).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("private-note-do-not-output");
    expect(JSON.stringify(preview)).not.toContain("private-leads-to-do-not-output");
    expect(transport).toHaveBeenCalledTimes(callsAfterFetch);

    const stored = h.db.prepare("SELECT fetched_at,payload_json FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap) as any;
    const staleFetchedAt = new Date(Date.parse(stored.fetched_at) - 60_001).toISOString();
    const stalePayload = JSON.parse(stored.payload_json);
    stalePayload.fixture.fetchedAt = staleFetchedAt;
    h.db.prepare("UPDATE wormholesystems_source_snapshots SET fetched_at=?,payload_json=? WHERE map_id=?")
      .run(staleFetchedAt, JSON.stringify(stalePayload), h.targetMap);
    const stalePreview = h.service.preview(h.targetMap) as any;
    expect(stalePreview.preview.source_signature_classification.total).toBe(12);
    expect(stalePreview.preview.source_snapshot).toMatchObject({ fresh_for_matching: false,
      blockers: expect.arrayContaining(["source snapshot exceeds the configured maximum matching staleness"]) });

    stalePayload.schema = "wormholesystems-source-v2";
    stalePayload.adapterVersion = 2;
    stalePayload.fixture.schemaVersion = 2;
    for (const evidenceRow of stalePayload.fixture.sourceSignatureEvidence) {
      delete evidenceRow.signatureCategoryName;
      delete evidenceRow.nestedSignatureCategoryId;
      delete evidenceRow.nestedSignatureTypeId;
      delete evidenceRow.signatureTypeCategoryId;
    }
    h.db.prepare("UPDATE wormholesystems_source_snapshots SET payload_json=? WHERE map_id=?").run(JSON.stringify(stalePayload), h.targetMap);
    const legacyV2Preview = h.service.preview(h.targetMap) as any;
    expect(legacyV2Preview.preview.source_signature_classification.signatures[0]).toMatchObject({
      classification_status: "captured", signature_category_name_status: "not_captured_in_snapshot",
    });
    expect(legacyV2Preview.preview.source_signature_classification.signatures[0]).not.toHaveProperty("signature_category_name");
    expect(legacyV2Preview.preview.source_signature_classification.signatures[0]).not.toHaveProperty("signature_type_category_id");
    expect(legacyV2Preview.preview.topology_apply).toMatchObject({ eligible: false });
    expect(legacyV2Preview.source_snapshot_blockers).toContain("stored v1/v2 source snapshot is read-only; a fresh validated v3 snapshot is required for writes");

    stalePayload.schema = "wormholesystems-source-v1";
    stalePayload.adapterVersion = 1;
    stalePayload.fixture.schemaVersion = 1;
    delete stalePayload.fixture.sourceSignatureEvidence;
    h.db.prepare("UPDATE wormholesystems_source_snapshots SET payload_json=? WHERE map_id=?").run(JSON.stringify(stalePayload), h.targetMap);
    const legacyPreview = h.service.preview(h.targetMap) as any;
    expect(legacyPreview.preview.source_signature_classification).toMatchObject({ status: "not_captured_in_snapshot", total: 12, omitted: 0 });
    expect(legacyPreview.preview.source_signature_classification.signatures[0]).not.toHaveProperty("signature_type_id");
    expect(legacyPreview.preview.source_signature_classification.signatures[0].signature_category_name_status).toBe("not_captured_in_snapshot");
    expect(legacyPreview.preview.snapshot_blockers).toContain("stored v1/v2 source snapshot is read-only; a fresh validated v3 snapshot is required for writes");
    expect(transport).toHaveBeenCalledTimes(callsAfterFetch);
    h.db.close();
  });

  it("rejects an older verifiable source observation and retains the last snapshot as ineligible", async () => {
    const detailAt = (observed_at: string) => ({ ...selectedMapDetail(), observed_at });
    let detailCount = 0;
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: detailAt(["2026-10-13T11:50:00.000Z", "2026-10-13T11:49:00.000Z", "2026-10-13T11:48:00.000Z"][Math.min(detailCount++, 2)]) });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    const first = await h.service.syncMap(h.targetMap);
    const before = h.db.prepare("SELECT revision_or_digest FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap) as any;
    expect(first).toMatchObject({ status: "snapshot_validated", revision_ordering: "unknown" });
    const older = await h.service.syncMap(h.targetMap);
    expect(older).toMatchObject({ status: "fetch_failed", last_good_snapshot_retained: true, error: "WormholeSystems returned an older observed snapshot" });
    expect(h.db.prepare("SELECT revision_or_digest,eligible_for_matching FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap))
      .toMatchObject({ revision_or_digest: before.revision_or_digest, eligible_for_matching: 0 });
    expect(h.service.status(h.targetMap).last_attempt).toMatchObject({ revision_ordering: "observed_at", source_calls: 3 });
    h.db.close();
  });

  it("normalizes confirmed resource identities and leaves status and freshness unknown", async () => {
    const mapConnection = { id: "source-edge", from_map_solarsystem_id: "map-system-a", to_map_solarsystem_id: "map-system-b",
      mass_status: "stable", lifetime_status: "stable", lifetime_status_updated_at: "2026-10-13T11:59:00.000Z",
      signatures: [
        { id: "source-row-a", signature_id: "ABC-123", map_solarsystem_id: "map-system-a" },
        { id: "source-row-b", signature_id: "DEF-456", map_solarsystem_id: "map-system-b" },
      ] };
    const mapDetail = { ...selectedMapDetail(), map_solarsystems: [
      { id: "map-system-a", map_id: "api-map-7", solarsystem_id: "031000001" },
      { id: "map-system-b", map_id: "api-map-7", solarsystem_id: "031000002" },
    ], map_connections: [mapConnection], alias_settings: null, bookmark_settings: { nullable: null } };
    const signaturesA = [{ id: "source-row-a", signature_id: "ABC-123", map_solarsystem_id: "map-system-a",
      map_connection_id: "source-edge", wormhole_id: null, map_connection: { id: "source-edge" },
      status: "active", fresh_until: "2026-10-13T12:01:00.000Z" }];
    const signaturesB = [{ id: "source-row-b", signature_id: "DEF-456", map_solarsystem_id: "map-system-b",
      map_connection_id: "source-edge", wormhole_id: null, map_connection: { id: "source-edge" }, status: "active" }];
    const detailFor = (id: string, eveId: string, signatures: unknown[]) => ({ data: {
      id, map_id: "api-map-7", solarsystem_id: eveId, signatures, map_connections: [mapConnection],
      signatures_pasted_at: "2026-10-13T11:59:00.000Z", audits: [{ id: 9, created_at: "2026-10-13T11:59:00.000Z" }],
    } });
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      if (url.endsWith("/map-solarsystems/map-system-a")) return response(detailFor("map-system-a", "031000001", signaturesA));
      if (url.endsWith("/map-solarsystems/map-system-b")) return response(detailFor("map-system-b", "031000002", signaturesB));
      throw new Error("Unexpected source route");
    });
    const pacing = vi.fn(async () => {});
    const h = harness(transport as typeof fetch, pacing);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    const result = await h.service.syncMap(h.targetMap);
    expect(result).toMatchObject({ status: "snapshot_validated",
      source_calls: 4, snapshot_stored: true, systemCount: 2, signatureCount: 2, connectionCount: 1, auditRecordCount: 2,
      nexum_writes_attempted: false, topology_sync: { status: "blocked", attempted: false } });
    expect(transport.mock.calls.map(call => String(call[0]))).toEqual([
      "https://wormholes.invalid/api/maps", "https://wormholes.invalid/api/maps/api-map-7",
      "https://wormholes.invalid/api/map-solarsystems/map-system-a", "https://wormholes.invalid/api/map-solarsystems/map-system-b",
      "https://wormholes.invalid/api/maps",
      "https://wormholes.invalid/api/maps/api-map-7", "https://wormholes.invalid/api/map-solarsystems/map-system-a",
      "https://wormholes.invalid/api/map-solarsystems/map-system-b",
    ]);
    const stored = h.db.prepare("SELECT payload_json FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap) as any;
    const fixture = JSON.parse(stored.payload_json).fixture;
    expect(fixture.scope.eveSolarSystemIds).toEqual([31_000_001, 31_000_002]);
    expect(fixture.systems.map((system: any) => system.sourceSystemId)).toEqual(["map-system-a", "map-system-b"]);
    expect(fixture.topologyEvidence.systems).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceSystemId: "map-system-a", positionX: null, positionY: null }),
      expect.objectContaining({ sourceSystemId: "map-system-b", positionX: null, positionY: null }),
    ]));
    expect(fixture.signatures.map((signature: any) => signature.sourceSignatureId)).toEqual(["source-row-a", "source-row-b"]);
    expect(fixture.signatures.map((signature: any) => signature.signatureCode)).toEqual(["ABC-123", "DEF-456"]);
    expect(fixture.signatures.every((signature: any) => signature.sourceSignatureId !== signature.signatureCode)).toBe(true);
    expect(fixture.connections[0]).toMatchObject({ sourceConnectionId: "source-edge", fromEveSystemId: 31_000_001,
      toEveSystemId: 31_000_002, state: "unknown", observedAt: null, freshUntil: null });
    expect(fixture.signatures.every((signature: any) => signature.status === "unknown" && signature.observedAt === null && signature.freshUntil === null)).toBe(true);
    expect(fixture.observedAt).toBeNull();
    expect(JSON.parse(stored.payload_json).fixture.sourceMetadata.solarSystemDetails[0].data.audits).toHaveLength(1);
    expect(h.service.status(h.targetMap)).toMatchObject({ source_freshness_evidence: { system_observations: 0,
      signature_observations: 0, signature_freshness_deadlines: 0, connection_observations: 0, connection_freshness_deadlines: 0 } });
    const cachedState = h.store.state(h.targetMap) as any;
    cachedState.systems = [{ id: "cached-system", eveSystemId: 31_000_002, systemClass: "C6" }];
    h.store.saveState(h.targetMap, cachedState);
    const preview = h.service.preview(h.targetMap) as any;
    expect(preview.preview).toMatchObject({ local_only: true, upstream_calls: 0, writes_enabled: false });
    expect(preview.preview.topology_apply.eligible).toBe(false);
    expect(preview.preview.topology_apply.blockers).not.toContain("systems[0].positionX: verified source-owned map position is unavailable");
    expect(preview.preview.alliance_notes).toHaveLength(2);
    expect(preview.preview.alliance_notes.every((note: any) => note.eligible_for_write === false && note.blocking_fields.length > 0)).toBe(true);
    expect(preview.preview.alliance_notes.every((note: any) => !("desired_note" in note) && !("actual_note" in note) &&
      note.blocking_fields.some((reason: string) => reason.includes("alias") || reason.includes("home identity")))).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("desired_note");
    expect(JSON.stringify(preview)).not.toContain("actual_note");
    expect(h.nexumWrites.writeWormholesystemsTopology).not.toHaveBeenCalled();
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes).not.toHaveBeenCalled();
    expect(JSON.stringify(preview)).not.toContain("token-do-not-echo");
    expect(transport.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method === "GET")).toBe(true);
    h.db.close();
  });

  it("keeps linked-note PATCHes behind a separate explicit note-only operation", async () => {
    const edge = { id: "source-edge", from_map_solarsystem_id: "member-a", to_map_solarsystem_id: "member-b",
      type: "wormhole", ship_size: "medium", signatures: [
        { id: "source-row-a", signature_id: "ABC-123", map_solarsystem_id: "member-a" },
        { id: "source-row-b", signature_id: "DEF-456", map_solarsystem_id: "member-b" },
      ] };
    const mapDetail = { id: "api-map-7", slug: "api-slug", home_solarsystem_id: 31_000_001,
      map_solarsystems: [
        { id: "member-a", map_id: "api-map-7", solarsystem_id: 31_000_001, alias: "0", position: { x: 0, y: 0 } },
        { id: "member-b", map_id: "api-map-7", solarsystem_id: 31_000_002, alias: "1", position: { x: 1, y: 1 } },
      ], map_connections: [edge], bookmark_settings: { status_annotations: [] } };
    const detailFor = (memberId: string, eveId: number, signatureId: string, code: string) => ({ data: {
      id: memberId, map_id: "api-map-7", solarsystem_id: eveId,
      signatures: [{ id: signatureId, signature_id: code, map_solarsystem_id: memberId,
        map_connection_id: "source-edge", map_connection: { id: "source-edge" }, status: "active" },
        ...(memberId === "member-a" ? [{ id: "source-unconnected", signature_id: "GHI-789",
          map_solarsystem_id: memberId, map_connection_id: null, status: "active" }] : [])],
      map_connections: [edge], audits: [],
    } });
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: mapDetail });
      if (url.endsWith("/map-solarsystems/member-a")) return response(detailFor("member-a", 31_000_001, "source-row-a", "ABC-123"));
      if (url.endsWith("/map-solarsystems/member-b")) return response(detailFor("member-b", 31_000_002, "source-row-b", "DEF-456"));
      throw new Error("Unexpected source route");
    });
    const h = harness(transport as typeof fetch, async () => {}, () => "C2");
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    h.store.patchMap(h.targetMap, { health: "live", hydrated_at: now });
    h.store.saveState(h.targetMap, { systems: [
      { id: "nexum-a", eveSystemId: 31_000_001 }, { id: "nexum-b", eveSystemId: 31_000_002 },
    ], connections: [{ id: "nexum-edge", sourceId: "nexum-a", targetId: "nexum-b",
      sourceSignatureId: "nexum-row-a", targetSignatureId: "nexum-row-b", broken: false, timeStatus: "stable" }], routes: [] });
    h.store.saveResource(h.targetMap, "nexum-a", "signatures", [
      { id: "nexum-row-a", signature: "ABC-123", status: "active", notes: "" },
    ]);
    h.store.saveResource(h.targetMap, "nexum-b", "signatures", [
      { id: "nexum-row-b", signature: "DEF-456", status: "active", notes: "..1-0 DEF-456 C2 medium" },
    ]);

    expect(await h.service.syncMap(h.targetMap)).toMatchObject({ status: "snapshot_validated", nexum_writes_attempted: false,
      linked_note_writes_attempted: false });
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes).not.toHaveBeenCalled();
    const preview = h.service.preview(h.targetMap) as any;
    expect(preview.preview.unmatched).toContainEqual(expect.objectContaining({ source_signature_id: "source-unconnected",
      reason: "no_source_connection_reference" }));
    expect(preview.preview.alliance_notes).toMatchObject([
      { source_signature_key: expect.any(String), eligible_for_write: true, pending: true },
      { source_signature_key: expect.any(String), eligible_for_write: true, pending: false },
    ]);
    expect(JSON.stringify(preview)).not.toContain(".0-1 ABC-123 C2 medium");
    expect(JSON.stringify(preview)).not.toContain("..1-0 DEF-456 C2 medium");
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes).not.toHaveBeenCalled();

    const result = await h.service.reconcileLinkedNotes(h.targetMap);
    expect(result).toMatchObject({ status: "completed", eligible_direction_count: 2, attempted_direction_count: 1, written_count: 1 });
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes).toHaveBeenCalledTimes(1);
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes.mock.calls[0][0]).toBe(h.targetMap);
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes.mock.calls[0][1]).toEqual([
      { systemId: "nexum-a", signatureId: "nexum-row-a", notes: ".0-1 ABC-123 C2 medium",
        expectedIdentity: expect.objectContaining({ connectionId: "nexum-edge", signatureCode: "ABC-123" }) },
    ]);
    expect(JSON.stringify(result)).not.toContain(".0-1 ABC-123 C2 medium");
    expect(transport.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method === "GET")).toBe(true);
    h.db.close();
  });

  it("caps classification diagnostics at 500 rows and reports exact totals and omissions", async () => {
    const signatures = Array.from({ length: 501 }, (_, index) => ({ id: `source-row-${index}`,
      signature_id: `AAA-${String(index).padStart(3, "0")}`, map_solarsystem_id: "map-system-test", map_connection_id: null }));
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      if (url.endsWith("/map-solarsystems/map-system-test")) return response(systemDetail("map-system-test", 31_000_001, signatures));
      throw new Error("Unexpected source route");
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    const connectionTest = await h.service.testConnection();
    if (connectionTest.status !== "maps_detail_schema_ok") throw new Error(JSON.stringify(connectionTest));
    h.service.enableSync();
    expect(await h.service.syncMap(h.targetMap)).toMatchObject({ status: "snapshot_validated", signatureCount: 501 });
    const preview = h.service.preview(h.targetMap) as any;
    expect(preview.preview.source_signature_classification).toMatchObject({ total: 501, omitted: 1 });
    expect(preview.preview.source_signature_classification.signatures).toHaveLength(500);
    expect(preview.preview.source_signature_classification.signatures.length).toBeLessThanOrEqual(500);
    h.db.close();
  });

  it("projects exact bounded source classification while preserving absent and explicit-null fields", () => {
    const sourceSignature = (signature: Record<string, unknown>) => normalizeSourceSnapshot({
      mapId: "source-map", canonicalMapId: "canonical-map", sourceIdentity: "wormholesystems:synthetic-source",
      revisionOrDigest: "synthetic-revision", fetchedAt: "2026-10-13T12:00:00.000Z",
      detail: { data: { id: "source-map", map_solarsystems: [
        { id: "member-row", map_id: "source-map", solarsystem_id: 31_000_001 },
      ], map_connections: [] } },
      systemDetails: [{ data: { id: "member-row", map_id: "source-map", solarsystem_id: 31_000_001,
        signatures: [{ id: "opaque-signature-resource", signature_id: "RZQ-108", map_solarsystem_id: "member-row", ...signature }],
        map_connections: [], audits: [] } }],
    });
    const valid = sourceSignature({ signature_type_id: "synthetic-type-id", signature_type: { id: "synthetic-type-id", signature_category_id: null },
      signature_category_id: null, signature_category: { id: null, name: "Wormhole" },
      wormhole_id: "synthetic-wormhole-id", wormhole: { id: "synthetic-wormhole-id", name: "synthetic-label-not-a-wh-code",
        leads_to: "must-not-be-projected" }, notes: "private-source-note" });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.fixture.schemaVersion).toBe(3);
      expect(valid.fixture.sourceSignatureEvidence).toEqual([{
        sourceSignatureId: "opaque-signature-resource", scannerEveSystemId: 31_000_001, signatureCode: "RZQ-108",
        signatureTypeId: "synthetic-type-id", signatureCategoryId: null, signatureCategoryName: "Wormhole",
        nestedSignatureCategoryId: null, nestedSignatureTypeId: "synthetic-type-id", signatureTypeCategoryId: null,
        wormholeId: "synthetic-wormhole-id",
        nestedWormholeId: "synthetic-wormhole-id", wormholeName: "synthetic-label-not-a-wh-code",
      }]);
      expect(JSON.stringify(valid.fixture.sourceSignatureEvidence)).not.toContain("must-not-be-projected");
      expect(JSON.stringify(valid.fixture.sourceSignatureEvidence)).not.toContain("private-source-note");
    }

    const absent = sourceSignature({});
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      const evidence = absent.fixture.sourceSignatureEvidence![0];
      expect(evidence).not.toHaveProperty("signatureTypeId");
      expect(evidence).not.toHaveProperty("signatureCategoryId");
      expect(evidence).not.toHaveProperty("wormholeId");
      expect(evidence).not.toHaveProperty("nestedWormholeId");
      expect(evidence).not.toHaveProperty("wormholeName");
    }

    const unassigned = sourceSignature({ signature_id: null, signature_type_id: null, signature_category_id: null,
      signature_type: { id: null, signature_category_id: null }, signature_category: { id: null, name: null },
      wormhole_id: null, wormhole: { id: null, name: null } });
    // `signature_id` is supplied by the base object above; the source adapter
    // preserves a null assigned-code state rather than fabricating a code.
    expect(unassigned.ok).toBe(true);
    if (unassigned.ok) expect(unassigned.fixture.sourceSignatureEvidence![0]).toMatchObject({
      signatureCode: null, signatureTypeId: null, signatureCategoryId: null, signatureCategoryName: null,
      nestedSignatureCategoryId: null, nestedSignatureTypeId: null, signatureTypeCategoryId: null,
      wormholeId: null, nestedWormholeId: null, wormholeName: null,
    });

    for (const malformed of [
      { signature_type_id: { unexpected: true } },
      { signature_category_id: "x".repeat(129) },
      { signature_category: "malformed" },
      { signature_category: { id: 1, name: "x".repeat(129) } },
      { signature_category: { id: 1, name: " Data Site" } },
      { signature_category: { id: 1, name: "Data\u0000Site" } },
      { signature_category: { id: 1, name: "Data\u0085Site" } },
      { signature_category_id: 1, signature_category: { id: 2, name: "Data Site" } },
      { signature_category_id: null, signature_category: { id: 1, name: "Data Site" } },
      { signature_type_id: 1, signature_type: { id: 2 } },
      { signature_category_id: 1, signature_type: { signature_category_id: 2 } },
      { wormhole_id: "synthetic-wormhole-id", wormhole: { id: "contradictory-wormhole-id" } },
      { wormhole: { name: "x".repeat(129) } },
    ]) expect(sourceSignature(malformed).ok).toBe(false);
  });

  it("cross-references nested signature resource IDs and rejects missing IDs locally and at the connection gate", async () => {
    const mapSystems = [
      { id: "map-system-a", map_id: "api-map-7", solarsystem_id: 31_000_001 },
      { id: "map-system-b", map_id: "api-map-7", solarsystem_id: 31_000_002 },
    ];
    const signatureA = { id: "signature-resource-a", signature_id: "ABC-123", map_solarsystem_id: "map-system-a" };
    const signatureB = { id: "signature-resource-b", signature_id: "DEF-456", map_solarsystem_id: "map-system-b" };
    const referenceA = { id: signatureA.id, signature_id: signatureA.signature_id, map_solarsystem_id: signatureA.map_solarsystem_id };
    const referenceB = { id: signatureB.id, signature_id: signatureB.signature_id, map_solarsystem_id: signatureB.map_solarsystem_id };
    const connection = (signatures: unknown[]) => ({ id: "edge", from_map_solarsystem_id: "map-system-a",
      to_map_solarsystem_id: "map-system-b", signatures });
    const makeSystemDetails = (systemConnections: [unknown, unknown]) => [
      { data: { ...systemDetail("map-system-a", 31_000_001, [signatureA], "api-map-7").data, map_connections: [systemConnections[0]] } },
      { data: { ...systemDetail("map-system-b", 31_000_002, [signatureB], "api-map-7").data, map_connections: [systemConnections[1]] } },
    ];
    const normalize = (mapConnections: unknown[], systemConnections: [unknown, unknown]) => normalizeSourceSnapshot({
      mapId: "api-map-7", canonicalMapId: "canonical", sourceIdentity: "wormholesystems:fixture", revisionOrDigest: "digest",
      fetchedAt: "2026-10-13T12:00:00.000Z", detail: { data: { id: "api-map-7", map_solarsystems: mapSystems, map_connections: mapConnections } },
      systemDetails: makeSystemDetails(systemConnections),
    });
    const valid = normalize([connection([referenceA, referenceB])], [connection([referenceA]), connection([referenceB])]);
    expect(valid).toMatchObject({ ok: true });
    if (valid.ok) expect(valid.fixture.signatures.map(signature => [signature.sourceSignatureId, signature.signatureCode])).toEqual([
      ["signature-resource-a", "ABC-123"], ["signature-resource-b", "DEF-456"],
    ]);
    if (valid.ok) expect(valid.fixture.connections[0]).toMatchObject({ fromSignatureKey: expect.stringContaining("signature-resource-a"),
      toSignatureKey: expect.stringContaining("signature-resource-b") });

    const missingIdA = { signature_id: "ABC-123", map_solarsystem_id: "map-system-a" };
    expect(normalize([connection([missingIdA, referenceB])], [connection([referenceA]), connection([referenceB])]))
      .toMatchObject({ ok: false });
    expect(normalize([connection([referenceA, referenceB])], [connection([missingIdA]), connection([referenceB])]))
      .toMatchObject({ ok: false });
    const missingDirectionalLink = normalize([connection([{ ...referenceA, id: "wrong-signature-resource" }, referenceB])],
      [connection([{ ...referenceA, id: "wrong-signature-resource" }]), connection([referenceB])]);
    expect(missingDirectionalLink).toMatchObject({ ok: true });
    if (missingDirectionalLink.ok) expect(missingDirectionalLink.fixture.connections[0]).toMatchObject({
      fromSignatureKey: null, toSignatureKey: expect.stringContaining("signature-resource-b"),
    });
    const duplicate = normalize([connection([referenceA, { ...referenceB, id: referenceA.id }])],
      [connection([referenceA]), connection([referenceB])]);
    expect(duplicate).toMatchObject({ ok: false });
    if (!duplicate.ok) expect(duplicate.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      path: "$.data.map_connections[0].signatures[1].id", reason: "duplicate connection signature resource reference",
    })]));

    const invalidMapDetail = { id: "api-map-7", map_solarsystems: mapSystems,
      map_connections: [connection([missingIdA, referenceB])] };
    const details = makeSystemDetails([connection([referenceA]), connection([referenceB])]);
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: invalidMapDetail });
      if (url.endsWith("/map-solarsystems/map-system-a")) return response(details[0]);
      if (url.endsWith("/map-solarsystems/map-system-b")) return response(details[1]);
      throw new Error("Unexpected source route");
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    expect(await h.service.testConnection()).toMatchObject({ status: "request_failed", live_sync_enabled: false,
      error: expect.stringContaining("$.data.map_connections[0].signatures[0].id") });
    expect(h.service.configuration()).toMatchObject({ live_sync_enabled: false, schema_validated_at: null });
    h.db.close();
  });

  it("rejects a nested signature resource reused under distinct connections without a direct connection ID", () => {
    const mapSystems = [
      { id: "map-system-a", map_id: "api-map-7", solarsystem_id: 31_000_001 },
      { id: "map-system-b", map_id: "api-map-7", solarsystem_id: 31_000_002 },
    ];
    const reference = { id: "shared-signature-resource", signature_id: "ABC-123", map_solarsystem_id: "map-system-a" };
    const connection = (id: string) => ({ id, from_map_solarsystem_id: "map-system-a",
      to_map_solarsystem_id: "map-system-b", signatures: [reference] });
    const edgeA = connection("edge-a");
    const edgeB = connection("edge-b");
    const result = normalizeSourceSnapshot({ mapId: "api-map-7", canonicalMapId: "canonical", sourceIdentity: "wormholesystems:fixture",
      revisionOrDigest: "digest", fetchedAt: "2026-10-13T12:00:00.000Z",
      detail: { data: { id: "api-map-7", map_solarsystems: mapSystems, map_connections: [edgeA, edgeB] } },
      systemDetails: [
        { data: { id: "map-system-a", map_id: "api-map-7", solarsystem_id: 31_000_001,
          signatures: [{ ...reference, map_connection_id: null }], map_connections: [edgeA, edgeB], audits: [] } },
        { data: { id: "map-system-b", map_id: "api-map-7", solarsystem_id: 31_000_002,
          signatures: [], map_connections: [], audits: [] } },
      ],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.issues).toContainEqual({ path: "$.data.map_connections[1].signatures[0].id",
      reason: "connection signature resource is reused under a different map connection" });
  });

  it("keeps sync disabled when the connection test finds a signature reused across map connections", async () => {
    const mapSystems = [
      { id: "map-system-a", map_id: "api-map-7", solarsystem_id: 31_000_001 },
      { id: "map-system-b", map_id: "api-map-7", solarsystem_id: 31_000_002 },
    ];
    const reference = { id: "shared-signature-resource", signature_id: "ABC-123", map_solarsystem_id: "map-system-a" };
    const connection = (id: string) => ({ id, from_map_solarsystem_id: "map-system-a",
      to_map_solarsystem_id: "map-system-b", signatures: [reference] });
    const edgeA = connection("edge-a");
    const edgeB = connection("edge-b");
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: { id: "api-map-7", map_solarsystems: mapSystems,
        map_connections: [edgeA, edgeB] } });
      if (url.endsWith("/map-solarsystems/map-system-a")) return response({ data: { id: "map-system-a", map_id: "api-map-7",
        solarsystem_id: 31_000_001, signatures: [{ ...reference, map_connection_id: null }], map_connections: [edgeA, edgeB], audits: [] } });
      if (url.endsWith("/map-solarsystems/map-system-b")) return response({ data: { id: "map-system-b", map_id: "api-map-7",
        solarsystem_id: 31_000_002, signatures: [], map_connections: [], audits: [] } });
      throw new Error("Unexpected source route");
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    expect(await h.service.testConnection()).toMatchObject({ status: "request_failed", live_sync_enabled: false,
      error: expect.stringContaining("$.data.map_connections[1].signatures[0].id") });
    expect(h.service.configuration()).toMatchObject({ live_sync_enabled: false, schema_validated_at: null });
    expect(() => h.service.enableSync()).toThrow("successful connection and selected-map schema test");
    h.db.close();
  });

  it("preserves unknown source status and nullable alias fields without inferring their meaning", () => {
    const at = "2026-10-13T11:59:00.000Z";
    const result = normalizeSourceSnapshot({ mapId: "source-map", canonicalMapId: "canonical-map", sourceIdentity: "wormholesystems:https://source.invalid/source-map",
      revisionOrDigest: "fixture-digest", fetchedAt: at, detail: { data: { id: "source-map", map_solarsystems: [
        { id: "map-system-a", map_id: "source-map", solarsystem_id: 31_000_001 },
        { id: "map-system-b", map_id: "source-map", solarsystem_id: 31_000_002 },
      ], map_connections: [{ id: "edge", from_map_solarsystem_id: "map-system-a", to_map_solarsystem_id: "map-system-b",
        status: "connected", observed_at: at, fresh_until: null, alias: null }],
      alias_settings: null, bookmark_settings: null } }, systemDetails: [
        { data: { ...systemDetail("map-system-a", 31_000_001, [{ id: "row-a", signature_id: "AAA-111", map_solarsystem_id: "map-system-a",
          map_connection_id: "edge", status: "resolved", observed_at: at, fresh_until: null }], "source-map").data,
          map_connections: [{ id: "edge", from_map_solarsystem_id: "map-system-a", to_map_solarsystem_id: "map-system-b" }] } },
        { data: { ...systemDetail("map-system-b", 31_000_002, [{ id: "row-b", signature_id: "BBB-222", map_solarsystem_id: "map-system-b",
          map_connection_id: "edge", status: "resolved", observed_at: at, fresh_until: null }], "source-map").data,
          map_connections: [{ id: "edge", from_map_solarsystem_id: "map-system-a", to_map_solarsystem_id: "map-system-b" }] } },
      ] });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.fixture.connections[0]).toMatchObject({ state: "unknown", freshUntil: null });
      expect(result.fixture.signatures.map(signature => signature.status)).toEqual(["unknown", "unknown"]);
      expect(result.fixture.sourceMetadata).toMatchObject({ map: { alias_settings: null, bookmark_settings: null,
        map_connections: [{ alias: null }] } });
      expect(result.fixture.observedAt).toBeNull();
      expect(result.fixture.connections[0].state).toBe("unknown");
      expect(result.fixture.connections[0].freshUntil).toBeNull();
      expect(result.fixture.signatures.every(signature => signature.status === "unknown" && signature.freshUntil === null)).toBe(true);
    }
  });

  it("rejects former candidate field names, identity mismatches and missing source identifiers", () => {
    const at = "2026-10-13T11:59:00.000Z";
    const base = {
      id: "source-map",
      map_solarsystems: [{ id: "member-row", map_id: "source-map", solarsystem_id: "031000001" }],
      map_connections: [],
    };
    const memberDetail = (data: Record<string, unknown>) => ({ data: {
      id: "member-row", map_id: "source-map", solarsystem_id: "031000001", signatures: [], map_connections: [], audits: [], ...data,
    } });
    const normalize = (map: unknown = base, details: unknown[] = [memberDetail({})]) => normalizeSourceSnapshot({
      mapId: "source-map", canonicalMapId: "canonical", sourceIdentity: "wormholesystems:fixture", revisionOrDigest: "digest", fetchedAt: at,
      detail: map, systemDetails: details,
    });
    expect(normalize({ ...base, map_solarsystems: [{ id: "member-row", map_id: "source-map", solar_system_id: 31_000_001 }] })).toMatchObject({
      ok: false, issues: expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("solarsystem_id") })]),
    });
    expect(normalize(base, [{ data: { id: "member-row", map_id: "source-map", solarsystem_id: 31_000_001,
      signatures: [], connections: [], audit: [] } }])).toMatchObject({ ok: false });
    expect(normalize(base, [memberDetail({ id: "different-row" })])).toMatchObject({ ok: false });
    expect(normalize({ ...base, map_connections: [{ id: "edge", from_map_solarsystem_id: "member-row", to_map_solarsystem_id: "outside" }] }))
      .toMatchObject({ ok: false });
    expect(normalize({ ...base, map_solarsystems: [{ id: "member-row", map_id: "other-map", solarsystem_id: 31_000_001 }] }))
      .toMatchObject({ ok: false });
    expect(normalize(base, [memberDetail({ map_id: "other-map" })])).toMatchObject({ ok: false });
    expect(normalize(base, [memberDetail({ solarsystem_id: 31_000_002 })])).toMatchObject({ ok: false });
    expect(normalize({ ...base, map_solarsystems: [{ map_id: "source-map", solarsystem_id: 31_000_001 }] })).toMatchObject({ ok: false });
    expect(normalize(base, [memberDetail({ id: undefined })])).toMatchObject({ ok: false });
    expect(normalize(base, [memberDetail({ map_id: undefined })])).toMatchObject({ ok: false });

    const connection = { id: "edge", from_map_solarsystem_id: "member-row", to_map_solarsystem_id: "member-row" };
    expect(normalize({ ...base, map_connections: [connection] })).toMatchObject({ ok: false });
    expect(normalize({ ...base, map_connections: [{ id: "edge", from_map_solarsystem_id: "member-row" }] })).toMatchObject({ ok: false });
    expect(normalize({ ...base, map_connections: [{ id: "edge", source_map_solarsystem_id: "member-row",
      target_map_solarsystem_id: "member-row" }] })).toMatchObject({ ok: false });

    const signatureDetail = memberDetail({ signatures: [{ id: "resource-signature", signature_id: "ABC-123",
      map_solarsystem_id: "member-row", map_connection_id: null, wormhole_id: "wormhole-resource",
      wormhole: { id: "wormhole-resource", leads_to: "031000002", total_mass: 1_000_000_000 } }] });
    const good = normalize(base, [signatureDetail]);
    expect(good).toMatchObject({ ok: true });
    if (good.ok) expect(good.fixture).toMatchObject({ scope: { eveSolarSystemIds: [31_000_001] },
      signatures: [{ sourceSignatureId: "resource-signature", signatureCode: "ABC-123", scannerEveSystemId: 31_000_001,
        connectedEveSystemId: null, sourceConnectionId: null }] });
    expect(normalize(base, [memberDetail({ signatures: [{ id: "resource-signature", signature_code: "ABC-123",
      map_solarsystem_id: "member-row", connection_id: null }] })])).toMatchObject({ ok: false });
    expect(normalize(base, [memberDetail({ signatures: [{ id: "resource-signature", signature_id: "ABC-123",
      map_solarsystem_id: "outside", map_connection_id: null }] })])).toMatchObject({ ok: false });
    expect(normalize(base, [memberDetail({ signatures: [{ signature_id: "ABC-123", map_solarsystem_id: "member-row" }] })]))
      .toMatchObject({ ok: false });
  });

  it("aborts and awaits deferred source operations before shutdown returns", async () => {
    let mapCalls = 0;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let aborted = false;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/maps")) {
        mapCalls++;
        if (mapCalls === 2) return new Promise<Response>((_resolve, reject) => {
          entered();
          init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
        });
        return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      }
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    const sync = h.service.syncMap(h.targetMap);
    await started;
    const stopped = h.service.stop();
    await expect(sync).resolves.toMatchObject({ status: "fetch_failed", source_calls: 1 });
    await stopped;
    expect(aborted).toBe(true);
    expect(h.db.prepare("SELECT count(*) AS n FROM wormholesystems_source_runs WHERE map_id=?").get(h.targetMap)).toMatchObject({ n: 1 });
    const prepare = vi.spyOn(h.db, "prepare");
    const afterStopPrepareCount = prepare.mock.calls.length;
    h.db.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(prepare).toHaveBeenCalledTimes(afterStopPrepareCount);
  });

  it("coalesces concurrent one-map syncs and prevents configuration changes until completion", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let mapRequests = 0;
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) {
        mapRequests++;
        if (mapRequests === 2) {
        entered();
        await gate;
        }
        return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      }
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    const first = h.service.syncMap(h.targetMap);
    await started;
    expect(() => h.service.configure({ origin: "https://wormholes.invalid", api_path_prefix: "/api", map_route_key: "id",
      canonical_map_id: h.targetMap, upstream_map_id: "api-map-7", credential_id: h.service.listCredentials()[0].id })).toThrow("cannot change during a source operation");
    const second = h.service.syncMap(h.targetMap);
    expect(transport).toHaveBeenCalledTimes(4);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(transport).toHaveBeenCalledTimes(6);
    h.db.close();
  });

  it("serializes source snapshot staging against Nexum map mutations through the shared map boundary", async () => {
    let systemDetailCalls = 0;
    let fetched!: () => void;
    const allFetched = new Promise<void>(resolve => { fetched = resolve; });
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/maps")) return response({ data: [{ id: "api-map-7", slug: "api-slug" }] });
      if (url.endsWith("/maps/api-map-7")) return response({ data: selectedMapDetail() });
      systemDetailCalls++;
      if (systemDetailCalls === 2) fetched();
      return response(testSystemDetail());
    });
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);

    let releaseStage!: () => void;
    let stageLocked!: () => void;
    const stageGate = new Promise<void>(resolve => { releaseStage = resolve; });
    const locked = new Promise<void>(resolve => { stageLocked = resolve; });
    const originalRun = mapDecisionBoundary.run.bind(mapDecisionBoundary);
    let paused = false;
    vi.spyOn(mapDecisionBoundary as any, "run").mockImplementation((mapId: string, operation: () => unknown) => {
      if (mapId === h.targetMap && !paused) {
        paused = true;
        return originalRun(mapId, async () => { stageLocked(); await stageGate; return operation(); });
      }
      return originalRun(mapId, operation as any);
    });

    const sync = h.service.syncMap(h.targetMap);
    await allFetched;
    await locked;
    expect(h.db.prepare("SELECT count(*) AS n FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap)).toMatchObject({ n: 0 });

    const nexum = new NexumService(h.store, { put() {}, get() { return "unused"; }, remove() {} }, {} as any);
    const event = nexum.handleEvent(h.targetMap, { type: "map.meta", locked: true }, h.store.credential("nexum-test"));
    let reconciliationDone = false;
    const reconciliation = nexum.reconcileChainNotes(h.targetMap).then(value => { reconciliationDone = true; return value; });
    await Promise.resolve();
    expect(h.store.state(h.targetMap).locked).toBeUndefined();
    expect(reconciliationDone).toBe(false);
    expect(h.db.prepare("SELECT count(*) AS n FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap)).toMatchObject({ n: 0 });

    releaseStage();
    await Promise.all([sync, event, reconciliation]);
    expect(h.db.prepare("SELECT count(*) AS n FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap)).toMatchObject({ n: 1 });
    expect(h.store.state(h.targetMap).locked).toBe(true);
    expect(transport.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method === "GET")).toBe(true);
    await nexum.stop();
    h.db.close();
  });

  it("retains the last snapshot on authentication failure and journals failure as ineligible", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(response({ data: [{ id: "api-map-7", slug: "api-slug" }] }))
      .mockResolvedValueOnce(response({ data: selectedMapDetail() }))
      .mockResolvedValueOnce(response(testSystemDetail()))
      .mockResolvedValueOnce(response({ error: "sensitive response body" }, 401));
    const h = harness(transport as typeof fetch);
    await configured(h.service, h.targetMap);
    await enableAfterTest(h.service);
    h.db.prepare(`INSERT INTO wormholesystems_source_snapshots(map_id,source_identity,source_origin,source_api_map_id,revision_or_digest,fetched_at,observed_at,payload_json,eligible_for_matching)
      VALUES (?,?,?,?,?,?,NULL,?,0)`).run(h.targetMap, "wormholesystems:https://wormholes.invalid:api-map-7", "https://wormholes.invalid", "api-map-7", "last-good", "2026-10-12T00:00:00.000Z", JSON.stringify({ redacted: true }));
    expect(await h.service.syncMap(h.targetMap)).toMatchObject({ status: "fetch_failed", source_calls: 1,
      last_good_snapshot_retained: true, last_good_revision_or_digest: "last-good", error_status: 401,
      error: "WormholeSystems HTTP 401", eligible_for_matching: false, nexum_writes_attempted: false });
    expect(h.db.prepare("SELECT revision_or_digest,eligible_for_matching FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap))
      .toMatchObject({ revision_or_digest: "last-good", eligible_for_matching: 0 });
    expect(h.service.status(h.targetMap).last_attempt).toMatchObject({ status: "fetch_failed", error_status: 401 });
    expect(JSON.stringify(await h.service.syncMap(h.targetMap))).not.toContain("sensitive response body");
    h.db.close();
  });

  it("registers credential, source, sync and local-preview MCP tools and redacts batched credential arguments", async () => {
    const registered = new Map<string, (...args: any[]) => any>();
    const descriptions = new Map<string, string>();
    const server = { tool: (name: string, description: string, _schema: unknown, callback: (...args: any[]) => any) => {
      registered.set(name, callback); descriptions.set(name, description);
    } };
    const transport = vi.fn(async () => response({ data: [] }));
    const h = harness(transport as typeof fetch);
    registerWormholeSystemsTools(server as any, () => h.service);
    for (const name of ["wormholesystems_add_credential", "wormholesystems_test_connection", "wormholesystems_enable_sync", "wormholesystems_disable_sync", "wormholesystems_list_maps", "wormholesystems_get_config",
      "wormholesystems_bind_nexum_topology_writer",
      "wormholesystems_remove_config", "wormholesystems_sync_map", "wormholesystems_map_sync_status", "wormholesystems_preview_map_sync",
      "wormholesystems_reconcile_linked_notes",
      "wormholesystems_set_max_staleness"])
      expect(registered.has(name)).toBe(true);
    expect(descriptions.get("wormholesystems_sync_map")).toMatch(/fresh complete v3.*Nexum schema-v2 topology\/signature request.*same invocation/i);
    expect(descriptions.get("wormholesystems_bind_nexum_topology_writer")).toMatch(/confirms.*wormholesystems_sync scope.*v2 endpoint/i);
    expect(descriptions.get("wormholesystems_preview_map_sync")).toMatch(/local-only.*classification.*zero upstream/i);
    expect(descriptions.get("wormholesystems_reconcile_linked_notes")).toMatch(/PATCH.*linked-direction.*never acts on unconnected/i);
    const redacted = redactSecrets([{ jsonrpc: "2.0", method: "tools/call", params: {
      name: "wormholesystems_add_credential", arguments: { api_token: "top-secret", label: "oops top-secret" },
    } }]);
    expect(JSON.stringify(redacted)).not.toContain("top-secret");
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
    const added = await registered.get("wormholesystems_add_credential")!({ api_token: "tool-secret", label: "test" });
    expect(JSON.stringify(added)).not.toContain("tool-secret");
    await configured(h.service, h.targetMap);
    const policyResult = await registered.get("wormholesystems_set_max_staleness")!({ max_staleness_ms: 45_000 });
    expect(JSON.parse(policyResult.content[0].text)).toMatchObject({ committed: true,
      staleness_policy: { max_age_ms: 45_000, origin: "operator" } });
    const preview = await registered.get("wormholesystems_preview_map_sync")!({ map_id: h.targetMap });
    expect(JSON.parse(preview.content[0].text).preview.upstream_calls).toBe(0);
    const noteResult = await registered.get("wormholesystems_reconcile_linked_notes")!({ map_id: h.targetMap });
    expect(JSON.parse(noteResult.content[0].text)).toMatchObject({ map_id: h.targetMap, status: "blocked", attempted_direction_count: 0 });
    expect(h.nexumWrites.writeWormholesystemsSignatureNotes).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    h.db.close();
  });
});
