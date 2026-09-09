import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
vi.mock("../../src/auth/esi-client.js", () => ({ esiGet: vi.fn(), esiGetAll: vi.fn(), getActiveCharacter: vi.fn() }));
vi.mock("../../src/database.js", () => ({ getDatabase: () => ({}) }));
vi.mock("../../src/utils.js", () => ({
  enrichTypeName: (_: unknown, id: number) => `Type ${id}`,
  enrichSystemName: (_: unknown, id: number) => `System ${id}`,
  jsonResult: (data: unknown) => data,
}));
import { esiGet, esiGetAll, getActiveCharacter } from "../../src/auth/esi-client.js";
import { registerDailyTools } from "../../src/tools/daily.js";

describe("daily ESI tools", () => {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  beforeEach(() => {
    vi.resetAllMocks();
    registerDailyTools({ tool: (name: string, _description: string, _schema: unknown, handler: any) => { handlers[name] = handler; } } as unknown as McpServer);
    vi.mocked(getActiveCharacter).mockResolvedValue({ characterId: 42, characterName: "Pilot", scopes: "esi-contracts.read_character_contracts.v1 esi-clones.read_clones.v1" } as any);
  });
  it("rejects missing scopes before an ESI request", async () => {
    await expect(handlers.get_character_location({})).rejects.toThrow("esi_login");
    expect(esiGet).not.toHaveBeenCalled();
  });
  it("routes contract contents through the selected character and filters before paging", async () => {
    vi.mocked(esiGetAll).mockResolvedValue([{ type_id: 1 }, { type_id: 2, quantity: 3 }, { type_id: 2, quantity: 9 }]);
    const result = await handlers.get_contract_items({ character_id: 42, contract_id: 123, type_id: 2, offset: 1, limit: 1 });
    expect(esiGetAll).toHaveBeenCalledWith("/characters/42/contracts/123/items/", { characterId: 42 });
    expect(result).toMatchObject({ totalCount: 3, filteredCount: 2, nextOffset: null, data: [{ type_id: 2, type_name: "Type 2", quantity: 9 }] });
  });
  it("preserves clone metadata and enriches nested implants", async () => {
    vi.mocked(esiGet).mockResolvedValue({ home_location: { location_id: 600 }, jump_clones: [{ jump_clone_id: 12, implants: [99] }] });
    const result = await handlers.get_character_clones({});
    expect(result.data).toEqual({ home_location: { location_id: 600 }, jump_clones: [{ jump_clone_id: 12, implants: [99], implant_names: ["Type 99"] }] });
  });
  it("requires a contract ID before making requests", async () => {
    await expect(handlers.get_contract_items({})).rejects.toThrow("contract_id");
    expect(esiGetAll).not.toHaveBeenCalled();
  });
});
