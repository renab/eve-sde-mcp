import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
vi.mock("../../src/auth/esi-client.js", () => ({ esiGet: vi.fn(), esiGetAll: vi.fn(), getActiveCharacter: vi.fn() }));
vi.mock("../../src/tools/daily.js", () => ({ enrichDailyData: (x: unknown) => x }));
import { esiGet, esiGetAll, getActiveCharacter } from "../../src/auth/esi-client.js";
import { registerCorporationTools } from "../../src/tools/corporations.js";
import { corporationEndpoints, CORPORATION_SCOPES } from "../../src/corporation-endpoints.js";
const handlers: Record<string, (args: any) => Promise<any>> = {};
beforeEach(() => {
  vi.resetAllMocks();
  registerCorporationTools({ tool: (name: string, _d: unknown, shape: any, handler: any) => {
    handlers[name] = async args => handler(z.object(shape).parse(args));
  } } as unknown as McpServer);
  vi.mocked(getActiveCharacter).mockResolvedValue({ characterId: 42, scopes: CORPORATION_SCOPES.join(" ") } as any);
});
it("checks scopes before any ESI request", async () => {
  vi.mocked(getActiveCharacter).mockResolvedValue({ characterId: 42, scopes: "" } as any);
  await expect(handlers.get_corporation_contracts({ corporation_id: 88 })).rejects.toThrow("esi_login");
  expect(esiGet).not.toHaveBeenCalled();
  expect(esiGetAll).not.toHaveBeenCalled();
});
it("resolves membership and paginates mining observer records with the chosen character", async () => {
  vi.mocked(esiGet).mockResolvedValue({ corporation_id: 88 });
  vi.mocked(esiGetAll).mockResolvedValue([{ quantity: 1 }, { quantity: 2 }]);
  const result = await handlers.get_corporation_mining_observer({ character_id: 42, observer_id: 123, limit: 1 });
  expect(esiGetAll).toHaveBeenCalledWith("/corporation/88/mining/observers/123/", { characterId: 42 });
  expect(JSON.parse(result.content[0].text)).toMatchObject({ count: 2, nextOffset: 1, data: [{ quantity: 1 }] });
});
it("preserves public objects without requiring login", async () => {
  vi.mocked(esiGet).mockResolvedValue({ ceo_id: 42 });
  const result = await handlers.get_corporation_info({ corporation_id: 88 });
  expect(getActiveCharacter).not.toHaveBeenCalled();
  expect(esiGet).toHaveBeenCalledWith("/corporations/88/", { public: true });
  expect(JSON.parse(result.content[0].text)).toEqual({ ceo_id: 42 });
});
it("requires starbase system and preserves detail payload", async () => {
  await expect(handlers.get_corporation_starbase({ corporation_id: 88, starbase_id: 123 })).rejects.toThrow();
  vi.mocked(esiGet).mockResolvedValue({ fuels: [{ type_id: 1, quantity: 5 }] });
  await handlers.get_corporation_starbase({ corporation_id: 88, starbase_id: 123, system_id: 30000001 });
  expect(esiGet).toHaveBeenCalledWith("/corporations/88/starbases/123/?system_id=30000001", { characterId: 42 });
});
it("preserves scalar member limits and propagates role denials", async () => {
  vi.mocked(esiGet).mockResolvedValueOnce(6300).mockRejectedValueOnce(new Error("ESI 403 Forbidden"));
  const result = await handlers.get_corporation_members_limit({ corporation_id: 88 });
  expect(JSON.parse(result.content[0].text)).toBe(6300);
  await expect(handlers.get_corporation_roles({ corporation_id: 88 })).rejects.toThrow("403");
});
it("registers every added route exactly once with no fictional bills route", () => {
  const added = corporationEndpoints.filter(e => !e.existing);
  expect(new Set(added.map(e => e.name)).size).toBe(added.length);
  expect(Object.keys(handlers).sort()).toEqual(added.map(e => e.name).sort());
  expect(corporationEndpoints.some(e => e.path.includes("bills"))).toBe(false);
});

