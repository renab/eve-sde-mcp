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
import { WormholeSystemsService } from "../../src/wormholesystems.js";
import { normalizeSourceSnapshot } from "../../src/wormholesystems-adapter.js";
import { mapDecisionBoundary } from "../../src/map-decision-boundary.js";

const tmpDirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const response = (payload: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(payload), { status, headers });

function harness(transport: typeof fetch = vi.fn(async () => response({ data: [] })), sleep: (ms: number) => Promise<void> = async () => {}) {
  const db = openStateDatabase(":memory:");
  const store = new NexumStore(db, () => Date.parse("2026-10-13T12:00:00.000Z"));
  const credential = { id: "nexum-test", base_url: "https://nexum.invalid", label: "fixture", enabled: true };
  store.saveCredential(credential);
  store.discover(credential, [{ id: "target-map", name: "Target" }, { id: "other-map", name: "Other" }], credential.base_url);
  const secretValues = new Map<string, string>();
  const secrets = { put: (id: string, value: string) => secretValues.set(id, value), get: (id: string) => {
    const value = secretValues.get(id); if (!value) throw new Error("Credential secret unavailable"); return value;
  }, remove: (id: string) => secretValues.delete(id) };
  const service = new WormholeSystemsService(store, secrets, transport, () => Date.parse("2026-10-13T12:00:00.000Z"), sleep);
  const maps = store.maps();
  return { db, store, service, secrets, secretValues, targetMap: maps.find(map => map.name === "Target")!.id, otherMap: maps.find(map => map.name === "Other")!.id };
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
    expect(h.service.configuration()).toMatchObject({ live_sync_enabled: false });
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

  it("stores a full validated normalized snapshot transactionally and never writes to Nexum", async () => {
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
      source_api_map_id: "api-map-7", systemCount: 1, eligible_for_matching: false, eligible_for_writes: false,
      nexum_writes_attempted: false });
    const stored = h.db.prepare("SELECT * FROM wormholesystems_source_snapshots WHERE map_id=?").get(h.targetMap) as any;
    expect(stored.source_api_map_id).toBe("api-map-7");
    expect(stored.revision_or_digest).toBe(result.revision_or_digest);
    expect(stored.revision_or_digest).not.toBe("old-digest");
    expect(stored.eligible_for_matching).toBe(0);
    expect(JSON.parse(stored.payload_json)).toMatchObject({ schema: "wormholesystems-source-v1", adapterVersion: 1,
      fixture: { sourceKind: "wormholesystems", scope: { canonicalMapId: h.targetMap }, systems: [{ eveSolarSystemId: 31_000_001 }], signatures: [], connections: [] } });
    expect(transport.mock.calls.map(call => (call[1] as RequestInit).method)).toEqual(["GET", "GET", "GET", "GET", "GET", "GET"]);
    expect(transport.mock.calls.every(call => (call[1] as RequestInit).method !== "PATCH")).toBe(true);
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
    expect(result).toMatchObject({ status: "snapshot_validated", source_calls: 4, systemCount: 2,
      signatureCount: 2, connectionCount: 1, auditRecordCount: 2, eligible_for_writes: false, nexum_writes_attempted: false });
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
    const preview = h.service.preview(h.targetMap) as any;
    expect(preview.preview).toMatchObject({ local_only: true, upstream_calls: 0, writes_enabled: false });
    expect(JSON.stringify(preview)).not.toContain("token-do-not-echo");
    expect(transport.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method === "GET")).toBe(true);
    h.db.close();
  });

  it("cross-references nested signature resource IDs and rejects missing IDs locally and at the connection gate", async () => {
    const mapSystems = [
      { id: "map-system-a", map_id: "api-map-7", solarsystem_id: 31_000_001 },
      { id: "map-system-b", map_id: "api-map-7", solarsystem_id: 31_000_002 },
    ];
    const signatureA = { id: "signature-resource-a", signature_id: "ABC-123", map_solarsystem_id: "map-system-a", map_connection_id: "edge" };
    const signatureB = { id: "signature-resource-b", signature_id: "DEF-456", map_solarsystem_id: "map-system-b", map_connection_id: "edge" };
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

    const missingIdA = { signature_id: "ABC-123", map_solarsystem_id: "map-system-a" };
    expect(normalize([connection([missingIdA, referenceB])], [connection([referenceA]), connection([referenceB])]))
      .toMatchObject({ ok: false });
    expect(normalize([connection([referenceA, referenceB])], [connection([missingIdA]), connection([referenceB])]))
      .toMatchObject({ ok: false });
    expect(normalize([connection([{ ...referenceA, id: "wrong-signature-resource" }, referenceB])],
      [connection([referenceA]), connection([referenceB])])).toMatchObject({ ok: false });
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
    const server = { tool: (name: string, _description: string, _schema: unknown, callback: (...args: any[]) => any) => registered.set(name, callback) };
    const transport = vi.fn(async () => response({ data: [] }));
    const h = harness(transport as typeof fetch);
    registerWormholeSystemsTools(server as any, () => h.service);
    for (const name of ["wormholesystems_add_credential", "wormholesystems_test_connection", "wormholesystems_enable_sync", "wormholesystems_disable_sync", "wormholesystems_list_maps", "wormholesystems_get_config",
      "wormholesystems_remove_config", "wormholesystems_sync_map", "wormholesystems_map_sync_status", "wormholesystems_preview_map_sync"])
      expect(registered.has(name)).toBe(true);
    const redacted = redactSecrets([{ jsonrpc: "2.0", method: "tools/call", params: {
      name: "wormholesystems_add_credential", arguments: { api_token: "top-secret", label: "oops top-secret" },
    } }]);
    expect(JSON.stringify(redacted)).not.toContain("top-secret");
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
    const added = await registered.get("wormholesystems_add_credential")!({ api_token: "tool-secret", label: "test" });
    expect(JSON.stringify(added)).not.toContain("tool-secret");
    const preview = await registered.get("wormholesystems_preview_map_sync")!({ map_id: h.targetMap });
    expect(JSON.parse(preview.content[0].text).preview.upstream_calls).toBe(0);
    expect(transport).not.toHaveBeenCalled();
    h.db.close();
  });
});
