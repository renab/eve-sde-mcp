import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../src/database.js", () => ({ getDatabase: () => ({ prepare: () => ({ get }) }) }));
vi.mock("../../src/auth/esi-client.js", () => ({ esiCalculateRoute: vi.fn(), esiPost: vi.fn(), getActiveCharacter: vi.fn() }));
vi.mock("../../src/utils.js", () => ({ jsonResult: (data: unknown) => data }));
import { esiCalculateRoute, esiPost, getActiveCharacter } from "../../src/auth/esi-client.js";
import { registerNavigationTools } from "../../src/tools/navigation.js";

describe("route calculation tool", () => {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const args = { origin: "Aphi", destination: 2, preference: "safer", security_penalty: 50, avoid_systems: [9, 9] };
  beforeEach(() => {
    vi.resetAllMocks();
    registerNavigationTools({ tool: (name: string, _description: string, _schema: unknown, handler: any) => { handlers[name] = handler; } } as unknown as McpServer);
    get.mockImplementation(value => value === "Aphi" || value === 1
      ? { solarSystemID: 1, solarSystemName: "Aphi", security: 0.5 }
      : value === 2 ? { solarSystemID: 2, solarSystemName: "Amarr", security: 1 } : undefined);
  });
  it("resolves names and preserves ESI order with enrichment and unknown-system fallback", async () => {
    vi.mocked(esiCalculateRoute).mockResolvedValue({ route: [1, 3, 2] });
    const result = await handlers.get_route(args);
    expect(esiCalculateRoute).toHaveBeenCalledWith(1, 2, { preference: "Safer", security_penalty: 50, avoid_systems: [9] });
    expect(result).toMatchObject({ systemIds: [1, 3, 2], jumpCount: 2, systems: [
      { systemId: 1, systemName: "Aphi", securityStatus: 0.5 },
      { systemId: 3, systemName: null, securityStatus: null },
      { systemId: 2, systemName: "Amarr", securityStatus: 1 },
    ] });
    expect(getActiveCharacter).not.toHaveBeenCalled();
    expect(esiPost).not.toHaveBeenCalled();
  });
  it("rejects unknown systems before calling ESI", async () => {
    await expect(handlers.get_route({ ...args, origin: "Missing" })).rejects.toThrow("search_systems");
    expect(esiCalculateRoute).not.toHaveBeenCalled();
  });
  it("handles same-system routes and numeric strings", async () => {
    vi.mocked(esiCalculateRoute).mockResolvedValue({ route: [1] });
    expect(await handlers.get_route({ ...args, origin: "1", destination: 1, preference: "less_secure" })).toMatchObject({ jumpCount: 0 });
    expect(esiCalculateRoute).toHaveBeenCalledWith(1, 1, expect.objectContaining({ preference: "LessSecure" }));
  });
});
