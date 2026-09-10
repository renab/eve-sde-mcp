import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/auth/tokens.js", () => ({
  getCurrentCharacter: vi.fn(),
  getTokens: vi.fn(),
  updateTokens: vi.fn(),
}));

vi.mock("../../src/auth/oauth.js", () => ({
  refreshAccessToken: vi.fn(),
}));

import { esiGet, esiGetAll, esiPost, esiDelete, esiGetWithMetadata, esiCalculateRoute } from "../../src/auth/esi-client.js";
import { getTokens } from "../../src/auth/tokens.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("dated public route API", () => {
  it("posts without authentication or a local cache", async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => jsonResponse({ route: [1, 2] }));
    const body = { preference: "Safer" as const, security_penalty: 50, avoid_systems: [] };
    expect(await esiCalculateRoute(1, 2, body)).toEqual({ route: [1, 2] });
    await esiCalculateRoute(1, 2, body);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith("https://esi.evetech.net/route/1/2", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Compatibility-Date": "2025-09-30" },
      body: JSON.stringify(body),
      signal: expect.any(AbortSignal),
    });
  });
  it("surfaces route errors", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(jsonResponse({ error: "No route" }, { status: 404 }));
    await expect(esiCalculateRoute(1, 2, { preference: "Shorter", security_penalty: 50, avoid_systems: [] })).rejects.toThrow();
  });
});

function jsonResponse(data: unknown, opts?: { status?: number; headers?: Record<string, string> }): Response {
  const headers = new Headers({ "Content-Type": "application/json", ...(opts?.headers ?? {}) });
  return new Response(JSON.stringify(data), { status: opts?.status ?? 200, headers });
}

function setupAuth(): void {
  vi.mocked(getTokens).mockReturnValue({
    characterId: 12345,
    characterName: "Test Char",
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: new Date(Date.now() + 3600000),
    scopes: "esi-test.v1",
  });
}

describe("header-driven metadata cache", () => {
  it("shares public calls across character selections without authentication",async()=>{
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(jsonResponse({x:1},{headers:{"Cache-Control":"max-age=600"}}));
    await esiGet("/public-share/",{public:true,characterId:1});
    await esiGet("/public-share/",{public:true,characterId:2});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it("isolates private caches by character but not by access-token rotation",async()=>{
    mockFetch.mockReset(); setupAuth();
    mockFetch.mockResolvedValue(jsonResponse({x:1},{headers:{"Cache-Control":"max-age=600"}}));
    await esiGet("/private-share/",{characterId:12345});
    const character=vi.mocked(getTokens).mock.results.at(-1)!.value;
    vi.mocked(getTokens).mockReturnValue({...character,accessToken:"rotated"});
    await esiGet("/private-share/",{characterId:12345});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    vi.mocked(getTokens).mockReturnValue({...character,characterId:54321});
    mockFetch.mockResolvedValueOnce(jsonResponse({x:2},{headers:{"Cache-Control":"max-age=600"}}));
    expect(await esiGet("/private-share/",{characterId:54321})).toEqual({x:2});
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
  it("preserves metadata on hits and fetches again at upstream expiry", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-09-09T12:00:00Z");
      vi.setSystemTime(now);
      mockFetch.mockReset();
      mockFetch.mockResolvedValueOnce(jsonResponse({ amount: 5500 }, { headers: {
        Date: now.toUTCString(), Expires: new Date(+now + 60000).toUTCString(), ETag: '"pi-one"',
      } }));
      const first = await esiGetWithMetadata<{ amount: number }>("/pi-expiry-test/", { public: true });
      first.data.amount = 0;
      const hit = await esiGetWithMetadata<{ amount: number }>("/pi-expiry-test/", { public: true });
      expect(hit.data.amount).toBe(5500);
      expect(hit.metadata.cacheStatus).toBe("local_hit");
      expect(hit.metadata.esiFetchedAt).toBe(first.metadata.esiFetchedAt);
      expect(hit.metadata.esiETag).toBe('"pi-one"');
      vi.setSystemTime(+now + 60000);
      mockFetch.mockResolvedValueOnce(jsonResponse({ amount: 6000 }));
      expect((await esiGetWithMetadata<{ amount: number }>("/pi-expiry-test/", { public: true })).data.amount).toBe(6000);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("does not invent a TTL or cache no-store responses", async () => {
    for (const control of ["", "no-store, max-age=600", "no-cache, max-age=600"]) {
      mockFetch.mockReset();
      for (let i = 0; i < 2; i++) {
        mockFetch.mockResolvedValueOnce(jsonResponse({}, { headers: { "Cache-Control": control } }));
        const result = await esiGetWithMetadata(`/pi-control/${control}`, { public: true });
        expect(result.metadata.cacheStatus).toBe("esi_response");
        expect(result.metadata.localCacheExpiresAt).toBeNull();
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }
  });
});

describe("esiGet", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("fetches JSON from ESI", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ result: "ok" }));
    const data = await esiGet("/test/", { public: true });
    expect(data).toEqual({ result: "ok" });
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toContain("/test/");
  });

  it("sets Accept header", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await esiGet("/test/", { public: true });
    const requestInit = mockFetch.mock.calls[0][1];
    expect(requestInit.headers).toHaveProperty("Accept", "application/json");
  });

  it("caches responses when cacheTtlMs is set", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ cached: true }, { headers: { "cache-control": "max-age=60" } }));
    const first = await esiGet("/cache-test/", { public: true, cacheTtlMs: 60000 });
    const second = await esiGet("/cache-test/", { public: true, cacheTtlMs: 60000 });
    expect(first).toEqual({ cached: true });
    expect(second).toEqual({ cached: true });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("does not cache when cacheTtlMs is not set", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: 1 }))
      .mockResolvedValueOnce(jsonResponse({ data: 1 }));
    await esiGet("/no-cache/", { public: true });
    await esiGet("/no-cache/", { public: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on HTTP 420 with rate limit message", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("rate limited", {
        status: 420,
        headers: { "x-esi-error-limit-reset": "30" },
      })
    );
    await expect(esiGet("/test/", { public: true })).rejects.toThrow(
      /rate limited.*30 seconds/i
    );
  });

  it("throws on non-ok response with status and body", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(esiGet("/missing/", { public: true })).rejects.toThrow(/404.*not found/i);
  });

  it("warns on low error limit remaining", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({}, { headers: { "x-esi-error-limit-remain": "5" } })
    );
    await esiGet("/warn-test/", { public: true });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("5 errors remaining"));
    stderrSpy.mockRestore();
  });
});

describe("esiGetAll (pagination)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns data from single page when no X-Pages header", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([1, 2, 3]));
    const result = await esiGetAll("/single-page/", { public: true });
    expect(result).toEqual([1, 2, 3]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("returns data from single page when X-Pages is 1", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([1], { headers: { "x-pages": "1" } }));
    const result = await esiGetAll("/one-page/", { public: true });
    expect(result).toEqual([1]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("fetches and concatenates all pages", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([1, 2], { headers: { "x-pages": "3" } }))
      .mockResolvedValueOnce(jsonResponse([3, 4]))
      .mockResolvedValueOnce(jsonResponse([5, 6]));
    const result = await esiGetAll("/multi-page/", { public: true });
    expect(result).toEqual([1, 2, 3, 4, 5, 6]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("appends page param with & when URL has existing query params", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([1], { headers: { "x-pages": "2" } }))
      .mockResolvedValueOnce(jsonResponse([2]));
    await esiGetAll("/test/?type_id=123", { public: true });
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondUrl).toContain("&page=2");
    expect(secondUrl).not.toContain("?page=2");
  });

  it("appends page param with ? when URL has no query params", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([1], { headers: { "x-pages": "2" } }))
      .mockResolvedValueOnce(jsonResponse([2]));
    await esiGetAll("/test/", { public: true });
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondUrl).toContain("?page=2");
  });

  it("caches each page using its own upstream headers", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([1, 2], { headers: { "x-pages": "2", "cache-control": "max-age=60" } }))
      .mockResolvedValueOnce(jsonResponse([3, 4], { headers: { "cache-control": "max-age=60" } }));
    await esiGetAll("/cached-pages/", { public: true, cacheTtlMs: 60000 });
    const second = await esiGetAll("/cached-pages/", { public: true, cacheTtlMs: 60000 });
    expect(second).toEqual([1, 2, 3, 4]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("propagates rate limit errors on first page", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("rate limited", { status: 420, headers: { "x-esi-error-limit-reset": "10" } })
    );
    await expect(esiGetAll("/rate-limited/", { public: true })).rejects.toThrow(/rate limited/i);
  });
});

describe("esiPost", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    setupAuth();
  });

  it("sends POST with JSON body and auth header", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ fitting_id: 42 }));
    const result = await esiPost("/fittings/", { name: "test" }, { characterId: 12345 });
    expect(result).toEqual({ fitting_id: 42 });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/fittings/");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-access-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ name: "test" });
  });

  it("throws on error response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(esiPost("/test/", {}, { characterId: 12345 })).rejects.toThrow(/403/);
  });

  it("throws on rate limit", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 420, headers: { "x-esi-error-limit-reset": "15" } })
    );
    await expect(esiPost("/test/", {}, { characterId: 12345 })).rejects.toThrow(
      /rate limited/i
    );
  });
});

describe("esiDelete", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    setupAuth();
  });

  it("sends DELETE with auth header", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await esiDelete("/fittings/123/", { characterId: 12345 });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/fittings/123/");
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe("Bearer test-access-token");
  });

  it("throws on error response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(esiDelete("/test/", { characterId: 12345 })).rejects.toThrow(/404/);
  });

  it("throws on rate limit", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", { status: 420, headers: { "x-esi-error-limit-reset": "20" } })
    );
    await expect(esiDelete("/test/", { characterId: 12345 })).rejects.toThrow(
      /rate limited/i
    );
  });
});
