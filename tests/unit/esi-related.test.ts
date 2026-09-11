import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/auth/tokens.js", () => ({ getCurrentCharacter: vi.fn(), getTokens: vi.fn(), updateTokens: vi.fn(),
  listLoyaltyPointActivity: vi.fn(), recordLoyaltyPointSnapshot: vi.fn(), listCharacters: vi.fn(), getCurrentCharacterId: vi.fn() }));
vi.mock("../../src/auth/oauth.js", () => ({ refreshAccessToken: vi.fn() }));
import { getCurrentCharacter, getTokens } from "../../src/auth/tokens.js";
import { createMcpServer } from "../../src/server.js";
import { Ledger } from "../../src/ledger.js";
import { EntityIndex, extractEntityRefs } from "../../src/entities.js";
import { getStateDatabase } from "../../src/persistence.js";
import { collectResponseEntities, createEsiReadContext, enrichRelatedToolResult } from "../../src/esi-related.js";
import { jsonResult } from "../../src/utils.js";

describe("shared ESI record discovery", () => {
  let server: ReturnType<typeof createMcpServer>;
  let ledger: Ledger;
  const fetcher = vi.fn();
  const character = (id: number) => ({ characterId: id, characterName: `Pilot ${id}`, accessToken: `token-${id}`, refreshToken: "",
    expiresAt: new Date(Date.now() + 3600000), scopes: "esi-wallet.read_corporation_wallets.v1 esi-assets.read_assets.v1 esi-location.read_location.v1" });
  const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "cache-control": "max-age=600" } });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = (server as any)._registeredTools[name];
    return await tool.handler(tool.inputSchema.parse(args));
  };
  const data = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args)).content[0].text);
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getCurrentCharacter).mockReturnValue(character(42) as any);
    vi.mocked(getTokens).mockImplementation(id => character(id) as any);
    vi.stubGlobal("fetch", fetcher);
    server = createMcpServer(); ledger = new Ledger(getStateDatabase());
  });
  afterEach(async () => { await server.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("advertises new records on fresh cache hits when the response omits the character ID", async () => {
    fetcher.mockResolvedValue(response(100));
    const before = await data("get_wallet_balance");
    expect(before).toMatchObject({ characterName: "Pilot 42", balance: 100, related_records: [] });
    expect(before).not.toHaveProperty("characterId");
    const first = ledger.store({ namespace: "wormlife", kind: "wallet_note", key: "wallet", source_type: "user_observed", payload: { character_id: 42 } });
    const latest = ledger.store({ namespace: "wormlife", kind: "wallet_note", key: "wallet", source_type: "user_observed", payload: { character_id: 42 } }, first.id);
    const after = await data("get_wallet_balance");
    expect(after.related_records).toHaveLength(1);
    expect(after.related_records[0]).toMatchObject({ id: latest.id, source: "wormlife_record", source_type: "user_observed", match_scope: "request_context", matched_entity_refs: [{ type: "character", id: "42" }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(getStateDatabase().prepare("SELECT entry FROM esi_cache").all())).not.toContain("related_records");
  });

  it("isolates simultaneous character requests", async () => {
    ledger.store({ namespace: "wormlife", kind: "pilot", key: "42", payload: { character_id: 42 } });
    ledger.store({ namespace: "wormlife", kind: "pilot", key: "43", payload: { character_id: 43 } });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let arrivals = 0;
    fetcher.mockImplementation(async () => { if (++arrivals === 2) release(); await barrier; return response(100); });
    const [a, b] = await Promise.all([data("get_wallet_balance", { character_id: 42 }), data("get_wallet_balance", { character_id: 43 })]);
    expect(a.related_records.map((r: any) => r.key)).toEqual(["42"]);
    expect(b.related_records.map((r: any) => r.key)).toEqual(["43"]);
  });

  it("resolves a corporation from the successful request path even when returned rows omit it", async () => {
    const record = ledger.store({ namespace: "wormlife", kind: "corp_wallet", payload: { corporation_id: 99 } });
    fetcher.mockImplementation(async (url: string) => response(url.includes("/corporations/") ? [{ division: 1, balance: 5 }] : { corporation_id: 99 }));
    const result = await data("get_corporation_wallets");
    expect(result.data).toEqual([{ division: 1, balance: 5 }]);
    expect(result.related_records[0]).toMatchObject({ id: record.id, match_scope: "request_context", matched_entity_refs: [{ type: "corporation", id: "99" }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("matches only returned assets after filtering, preserves data, and makes no enrichment ESI calls", async () => {
    const keep = ledger.store({ namespace: "wormlife", kind: "inventory", payload: { type_id: 34 } });
    ledger.store({ namespace: "wormlife", kind: "inventory", payload: { type_id: 35 } });
    fetcher.mockResolvedValue(response([
      { item_id: 1, type_id: 34, quantity: 10, location_id: 60003760, location_type: "station", location_flag: "Hangar" },
      { item_id: 2, type_id: 35, quantity: 20, location_id: 60008494, location_type: "station", location_flag: "Hangar" },
    ]));
    const result = await data("get_character_assets", { location_id: 60003760 });
    expect(result.assets).toHaveLength(1); expect(result.assets[0]).toMatchObject({ typeId: 34, quantity: 10 });
    expect(result.related_records.map((r: any) => r.id)).toEqual([keep.id]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("exposes common controls on every ESI read family but excludes mutations and persistence", () => {
    const tools = (server as any)._registeredTools;
    const reads = ["get_wallet_balance", "get_wallet_journal", "get_character_skills", "get_skill_queue", "check_skill_requirements",
      "get_character_assets", "get_corporation_assets", "get_industry_jobs", "get_character_contracts", "get_fittings", "get_killmail",
      "get_loyalty_points", "get_route", "get_planetary_colonies", "get_character_ship", "get_character_blueprints",
      "get_corporation_wallets", "get_corporation_structures", "get_character_asset_names", "get_corporation_asset_locations", "get_system_kills"];
    for (const name of reads) {
      expect(tools[name].inputSchema.shape.include_related, name).toBeDefined();
      expect(tools[name].inputSchema.shape.record_namespace, name).toBeDefined();
      expect(tools[name].inputSchema.shape.related_limit, name).toBeDefined();
    }
    for (const name of ["save_fitting", "delete_fitting", "set_autopilot_destination", "esi_login", "store_record", "keep_warm_dataset"]) {
      expect(tools[name].inputSchema.shape.include_related, name).toBeUndefined();
    }
  });

  it("obeys opt-out and namespace selection without changing the cached ESI read", async () => {
    ledger.store({ namespace: "other", kind: "wallet", payload: { character_id: 42 } });
    fetcher.mockResolvedValue(response(5));
    expect((await data("get_wallet_balance")).related_records).toEqual([]);
    expect((await data("get_wallet_balance", { record_namespace: "other" })).related_records).toHaveLength(1);
    const off = await data("get_wallet_balance", { include_related: false });
    expect(off).not.toHaveProperty("related_records"); expect(off).not.toHaveProperty("related_record_context");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("covers read-only POST tools while preserving their array response shape", async () => {
    const record = ledger.store({ namespace: "wormlife", kind: "asset_note", payload: { item_id: 123 } });
    fetcher.mockResolvedValue(response([{ item_id: 123, position: { x: 0, y: 0, z: 0 } }]));
    const result = await call("get_character_asset_locations", { item_ids: [123] });
    expect(JSON.parse(result.content[0].text)).toEqual([{ item_id: 123, position: { x: 0, y: 0, z: 0 } }]);
    expect(JSON.parse(result.content[1].text).related_records[0].id).toBe(record.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBe("POST");
  });

  it("retains a public route's system identity and does not require authentication", async () => {
    const record = ledger.store({ namespace: "wormlife", kind: "route_note", payload: { solar_system_id: 30000142 } });
    vi.mocked(getCurrentCharacter).mockReturnValue(null);
    fetcher.mockResolvedValue(response({ route: [30000142, 30000144] }));
    const result = await data("get_route", { origin: 30000142, destination: 30000144 });
    expect(result.related_records[0].id).toBe(record.id);
    expect(result.systemIds).toEqual([30000142, 30000144]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not use the record index or ESI when primary authentication fails", async () => {
    vi.mocked(getCurrentCharacter).mockReturnValue(null);
    const lookup = vi.spyOn(EntityIndex.prototype, "related");
    await expect(call("get_wallet_balance")).rejects.toThrow("No authenticated character");
    expect(lookup).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes typed aliases, arrays and explicit discriminators without guessing ambiguous IDs", () => {
    const value = { blueprintTypeId: 34, product_type_id: 35, skillId: 36, shipTypeId: 37, systemId: 31000398,
      location_id: "9007199254740993", location_type: "structure", typeIds: [38, 39],
      context_id: 42, context_id_type: "character_id", owner_id: 123, first_party_id: 444, id: 999,
      unsafe: { item_id: Number.MAX_SAFE_INTEGER + 1 } };
    const indexed = extractEntityRefs(value);
    const found = [...collectResponseEntities(value).refs.values()];
    expect(found).toEqual(expect.arrayContaining(indexed));
    expect(indexed).toEqual(expect.arrayContaining([{ type: "type", id: "34" }, { type: "type", id: "36" },
      { type: "type", id: "39" }, { type: "structure", id: "9007199254740993" }, { type: "character", id: "42" }]));
    expect(found.some(r => ["123", "444", "999", String(Number.MAX_SAFE_INTEGER + 1)].includes(r.id))).toBe(false);
  });

  it("bounds large responses and preserves existing pagination and original input", () => {
    for (let i = 0; i < 5; i++) ledger.store({ namespace: "wormlife", kind: "type", payload: { type_id: 34 } });
    const payload = { nextOffset: 200, data: Array.from({ length: 15000 }, () => ({ type_id: 34 })) };
    const original = jsonResult(payload);
    const result = enrichRelatedToolResult(original, { related_limit: 2 }, createEsiReadContext());
    const enriched = JSON.parse(result.content[0].text);
    expect(enriched.nextOffset).toBe(200); expect(enriched.data).toEqual(payload.data);
    expect(enriched.related_records).toHaveLength(2);
    expect(enriched.related_record_context).toMatchObject({ has_more: true, entity_scan_truncated: true });
    expect(original).toEqual(jsonResult(payload));
    const broad = collectResponseEntities({ data: [{ type_id: 34 }, ...Array.from({ length: 25000 }, () => ({ type_id: 35 }))] });
    expect([...broad.refs.values()][0]).toEqual({ type: "type", id: "34" });
    expect(broad.truncated).toBe(true);
  });

  it("preserves arrays, non-JSON/errors and usable results when the index fails", () => {
    const original = jsonResult([{ type_id: 34 }]);
    const enriched = enrichRelatedToolResult(original, {}, createEsiReadContext());
    expect(enriched.content[0]).toEqual(original.content[0]); expect(enriched.content).toHaveLength(2);
    const plain = { content: [{ type: "text", text: "Not found" }] };
    expect(enrichRelatedToolResult(plain, {}, createEsiReadContext())).toBe(plain);
    const error = { ...original, isError: true };
    expect(enrichRelatedToolResult(error, {}, createEsiReadContext())).toBe(error);
    vi.spyOn(EntityIndex.prototype, "related").mockImplementation(() => { throw new Error("offline"); });
    const failed = JSON.parse(enrichRelatedToolResult(jsonResult({ type_id: 34, data: "valid" }), {}, createEsiReadContext()).content[0].text);
    expect(failed).toMatchObject({ data: "valid", related_record_context: { status: "unavailable" } });
    expect(failed).not.toHaveProperty("related_records");
  });

  it("does not recursively discover identities inside related-record pointers", () => {
    const context = collectResponseEntities({ related_records: [{ payload: { character_id: 42 } }], available_sources: [{ arguments: { type_id: 34 } }] });
    expect(context.refs.size).toBe(0);
  });

  it("preserves prior pointer contracts and reports additional shared matches separately", () => {
    const record = ledger.store({ namespace: "wormlife", kind: "type_note", payload: { type_id: 34 } });
    const existing = [{ id: "existing", kind: "legacy_pointer" }];
    const result = JSON.parse(enrichRelatedToolResult(jsonResult({ type_id: 34, related_records: existing, nextOffset: 8 }), {}, createEsiReadContext()).content[0].text);
    expect(result.related_records).toEqual(existing); expect(result.nextOffset).toBe(8);
    expect(result.related_record_context.additional_related_records[0].id).toBe(record.id);
  });
});
