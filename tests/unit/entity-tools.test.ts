import { beforeEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
vi.mock("../../src/auth/esi-client.js", () => ({ esiGet: vi.fn(), esiGetWithMetadata: vi.fn(), getActiveCharacter: vi.fn() }));
vi.mock("../../src/structures.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/structures.js")>(), resolveStructure: vi.fn() }));
import { esiGet, esiGetWithMetadata, getActiveCharacter } from "../../src/auth/esi-client.js";
import { registerPlanetaryTools } from "../../src/tools/planetary.js";
import { registerUniverseTools } from "../../src/tools/universe.js";
import { registerPersistenceTools } from "../../src/tools/persistence.js";
import { registerEntityContextTools } from "../../src/tools/entity-context.js";
import { registerTypeTools } from "../../src/tools/types.js";
import { registerOperationTools } from "../../src/tools/operations.js";
import { resolveStructure } from "../../src/structures.js";
import { Ledger } from "../../src/ledger.js";
import { getStateDatabase } from "../../src/persistence.js";

describe("entity discovery through MCP", () => {
  const tools: Record<string, { schema: z.ZodObject<any>; handler: (args: any) => Promise<any> }> = {};
  const call = async (name: string, args: unknown) => JSON.parse((await tools[name].handler(tools[name].schema.parse(args))).content[0].text);
  beforeEach(() => {
    vi.resetAllMocks();
    const server = { tool: (name: string, _description: string, schema: any, handler: any) => { tools[name] = { schema: z.object(schema), handler }; } } as unknown as McpServer;
    registerPlanetaryTools(server); registerUniverseTools(server); registerPersistenceTools(server); registerEntityContextTools(server);
    registerTypeTools(server); registerOperationTools(server);
    vi.mocked(getActiveCharacter).mockResolvedValue({ characterId: 641570826, characterName: "Test", scopes: "esi-planets.manage_planets.v1" } as any);
    vi.mocked(esiGet).mockResolvedValue({ name: "J154212 VIII", planet_id: 40371521, system_id: 31000398, type_id: 11 });
    vi.mocked(esiGetWithMetadata).mockImplementation(async endpoint => ({ data: endpoint.endsWith("/40371521/") ? { pins: [], routes: [], links: [] } : [{ planet_id: 40371521, solar_system_id: 31000398, last_update: "2026-09-10T12:00:00Z", num_pins: 1 }], metadata: { cacheStatus: "local_hit", localCacheFetchedAt: "2026-09-10T12:00:00Z" } }) as any);
  });
  it("advertises current density from both PI endpoints without extra ESI calls", async () => {
    const ledger = new Ledger(getStateDatabase());
    const old = ledger.store({ namespace: "wormlife", kind: "planet_resource_density", key: "density", payload: { planet_id: 40371521 } });
    const latest = ledger.store({ namespace: "wormlife", kind: "planet_resource_density", key: "density", source_type: "user_measured", payload: { planet_id: 40371521 } }, old.id);
    const result = await call("get_planetary_colonies", {});
    expect(result.colonies[0].related_records.map((r: any) => r.id)).toEqual([latest.id]);
    expect(esiGetWithMetadata).toHaveBeenCalledTimes(1); expect(esiGet).toHaveBeenCalledTimes(1);
    const layout = await call("get_planetary_colony", { planet_id: 40371521 });
    expect(layout.related_records[0]).toMatchObject({ id: latest.id, source: "wormlife_record", source_type: "user_measured" });
    expect((await call("get_planetary_colonies", { include_related: false })).colonies[0]).not.toHaveProperty("related_records");
    expect((await call("get_planetary_colonies", { record_namespace: "other" })).colonies[0].related_records).toEqual([]);
  });
  it("finds eight density records by system and related character sources; resolves only when requested", async () => {
    for (let i = 0; i < 8; i++) await call("store_record", { namespace: "wormlife", kind: "planet_resource_density", key: `density-${i}`, payload: { planet_id: 40371514 + i, solar_system_id: 31000398, character_id: i % 2 ? 641570826 : 99 } });
    const result = await call("get_entity_context", { entity_type: "solar_system", entity_id: 31000398, source_limit: 10 });
    expect(result.related_records).toHaveLength(8); expect(esiGetWithMetadata).not.toHaveBeenCalled();
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ subsystem: "esi_planetary_colonies", arguments: { character_id: 641570826 } }), expect.objectContaining({ subsystem: "esi_planetary_colonies", arguments: { character_id: 99 } })]));
    const resolved = await call("get_entity_context", { entity_type: "character", entity_id: 641570826, resolve_live: true, source_limit: 1 });
    expect(resolved.sources[0]).toMatchObject({ resolved: true, source: "esi_live", metadata: { cacheStatus: "local_hit" } });
    expect(esiGetWithMetadata).toHaveBeenCalledTimes(1);
    vi.mocked(getActiveCharacter).mockRejectedValue(new Error("Not authorized"));
    const denied = await call("get_entity_context", { entity_type: "character", entity_id: 641570826, resolve_live: true, source_limit: 1 });
    expect(denied.sources[0]).toMatchObject({ resolved: false, error: "Not authorized" });
  });
  it("uses the same resolver in a non-PI SDE endpoint and in record search", async () => {
    const record = await call("store_record", { namespace: "wormlife", kind: "route_observation", payload: { solar_system_id: 30000142 } });
    const system = await call("get_system", { system_id: 30000142 });
    expect(system.related_records[0].id).toBe(record.id);
    const stored = await call("get_record", { namespace: "wormlife", id: record.id, include_related: true });
    expect(stored.record.available_sources[0]).toMatchObject({ source: "sde_static", tool: "get_system" });
    const search = await call("search_records", { namespace: "wormlife", include_related: true });
    expect(search.records[0].available_sources[0].arguments).toEqual({ system_id: 30000142 });
    const context = await call("get_entity_context", { entity_type: "solar_system", entity_id: 30000142, resolve_sde: true });
    expect(context.sources[0]).toMatchObject({ resolved: true, data: { solarSystemName: "Jita" } });
  });
  it("advertises type and structure records and retains large structure IDs", async () => {
    const structureId = "9007199254740993";
    const record = await call("store_record", { namespace: "wormlife", kind: "inventory", payload: { structure_id: structureId, type_id: 34 } });
    expect((await call("get_type", { type_id: 34 })).related_records[0].id).toBe(record.id);
    vi.mocked(resolveStructure).mockResolvedValue({ structure_id: structureId, name: "Test" });
    expect((await call("get_structure", { structure_id: structureId })).related_records[0].id).toBe(record.id);
    vi.mocked(resolveStructure).mockClear();
    const context = await call("get_entity_context", { entity_type: "structure", entity_id: structureId });
    expect(context.sources[0]).toMatchObject({ subsystem: "esi_structure", arguments: { structure_id: structureId }, resolved: false });
    expect(resolveStructure).not.toHaveBeenCalled();
  });
});
