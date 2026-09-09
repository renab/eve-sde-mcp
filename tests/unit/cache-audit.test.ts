import { it, expect, vi } from "vitest";
vi.mock("../../src/auth/tokens.js", () => ({ getCurrentCharacter: vi.fn(), getTokens: vi.fn(), updateTokens: vi.fn() }));
vi.mock("../../src/auth/oauth.js", () => ({ refreshAccessToken: vi.fn() }));
import { esiGet, esiGetAll } from "../../src/auth/esi-client.js";
import { getTokens } from "../../src/auth/tokens.js";
const response = (data: unknown, age: number, pages = 1) => new Response(JSON.stringify(data), { headers: { "cache-control": `max-age=${age}`, "x-pages": String(pages) } });
it("refreshes only an expired page even when the first page remains fresh", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  try {
    vi.setSystemTime(new Date("2026-09-09T15:00:00Z"));
    fetcher.mockResolvedValueOnce(response([1], 600, 2)).mockResolvedValueOnce(response([2], 10));
    expect(await esiGetAll("/audit-pages/", { public: true })).toEqual([1, 2]);
    vi.setSystemTime(Date.now() + 11000);
    fetcher.mockResolvedValueOnce(response([3], 10));
    expect(await esiGetAll("/audit-pages/", { public: true })).toEqual([1, 3]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2][0]).toContain("page=2");
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
it("separates private results and authenticates before cache hits", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  try {
    vi.mocked(getTokens).mockImplementation(id => ({ characterId: id, characterName: "Test", accessToken: `token-${id}`, refreshToken: "", scopes: "", expiresAt: new Date(Date.now() + 3600000) }));
    fetcher.mockResolvedValueOnce(response([1], 600)).mockResolvedValueOnce(response([2], 600));
    expect(await esiGet("/private-shared/", { characterId: 1 })).toEqual([1]);
    expect(await esiGet("/private-shared/", { characterId: 2 })).toEqual([2]);
    vi.mocked(getTokens).mockReturnValue(null);
    await expect(esiGet("/private-shared/", { characterId: 1 })).rejects.toThrow("authenticated");
  } finally { vi.unstubAllGlobals(); }
});
