import { beforeEach, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
vi.mock("../../src/auth/esi-client.js", () => ({ esiGet: vi.fn(), esiGetAll: vi.fn(), esiPost: vi.fn(), getActiveCharacter: vi.fn() }));
vi.mock("../../src/tools/daily.js", () => ({ enrichDailyData: (x: unknown) => x }));
import { esiGet, esiGetAll, esiPost, getActiveCharacter } from "../../src/auth/esi-client.js";
import { registerOperationTools, OPERATION_SCOPES } from "../../src/tools/operations.js";
const handlers: Record<string, (args: any) => Promise<any>> = {};
beforeEach(() => {
  vi.resetAllMocks();
  registerOperationTools({ tool: (name: string, _d: unknown, _s: unknown, handler: any) => { handlers[name] = handler; } } as unknown as McpServer);
  vi.mocked(getActiveCharacter).mockResolvedValue({ characterId: 42, scopes: [...OPERATION_SCOPES, "esi-assets.read_assets.v1"].join(" ") } as any);
});
it("uses corporation membership, wallet division and selected character", async () => {
  vi.mocked(esiGet).mockResolvedValue({ corporation_id: 88 });
  vi.mocked(esiGetAll).mockResolvedValue([]);
  await handlers.get_corporation_wallet_journal({ character_id: 42, division: 3, limit: 10, offset: 0 });
  expect(esiGetAll).toHaveBeenCalledWith("/corporations/88/wallets/3/journal/", { characterId: 42 });
});
it("rejects missing scope before reading corporation information", async () => {
  vi.mocked(getActiveCharacter).mockResolvedValue({ characterId: 42, scopes: "" } as any);
  await expect(handlers.get_corporation_structures({})).rejects.toThrow("esi_login");
  expect(esiGet).not.toHaveBeenCalled();
});
it("uses the wallet transaction cursor without page pagination", async () => {
  vi.mocked(esiGet).mockResolvedValue([]);
  await handlers.get_corporation_wallet_transactions({ corporation_id: 88, division: 2, from_id: 123, limit: 10, offset: 0 });
  expect(esiGet).toHaveBeenCalledWith("/corporations/88/wallets/2/transactions/?from_id=123", { characterId: 42 });
  expect(esiGetAll).not.toHaveBeenCalled();
});
it("does not require authentication for LP offers and filters before pagination", async () => {
  vi.mocked(esiGetAll).mockResolvedValue([{ type_id: 1 }, { type_id: 2 }, { type_id: 2 }]);
  const result = await handlers.get_loyalty_store_offers({ corporation_id: 88, type_id: 2, limit: 1, offset: 0 });
  expect(getActiveCharacter).not.toHaveBeenCalled();
  expect(JSON.parse(result.content[0].text)).toMatchObject({ count: 2, nextOffset: 1, data: [{ type_id: 2 }] });
});
it("deduplicates character asset name IDs and uses read POST", async () => {
  vi.mocked(esiPost).mockResolvedValue([]);
  await handlers.get_character_asset_names({ item_ids: [123, 123, 456] });
  expect(esiPost).toHaveBeenCalledWith("/characters/42/assets/names/", [123, 456], { characterId: 42 });
});
it("matches an incursion's infested systems", async () => {
  vi.mocked(esiGetAll).mockResolvedValue([{ infested_solar_systems: [10, 20] }, { infested_solar_systems: [30] }]);
  const result = await handlers.get_incursions({ system_id: 20, limit: 10, offset: 0 });
  expect(JSON.parse(result.content[0].text).count).toBe(1);
});
