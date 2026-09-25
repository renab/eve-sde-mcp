import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  getCallbackConfig,
  startLoginFlow,
  waitForLogin,
} from "../src/auth/oauth.js";

// The main HTTP server resolves the callback route path at import time (like
// HOST/PORT), so configure the public callback URL before importing it.
const PUBLIC_CALLBACK_URL = "https://galaxy.example.net/galaxy/callback";
process.env.EVE_SSO_CALLBACK_URL = PUBLIC_CALLBACK_URL;

let app: import("express").Express;
let server: Server;
let endpoint: string;
let lastExchangeRedirectUri: string | null = null;

beforeAll(async () => {
  const http = await import("../src/http.js");
  app = http.app;
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.signature`;
}

function stubTokenEndpoint(): void {
  // Only intercept the EVE SSO token endpoint; pass every other request
  // (e.g. the test's own callback GETs to the local app) through to the
  // real fetch.
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!target.startsWith("https://login.eveonline.com/")) {
        return realFetch(input, init);
      }
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(String(init?.body ?? ""));
      lastExchangeRedirectUri = body.get("redirect_uri");
      return new Response(
        JSON.stringify({
          access_token: makeJwt({ sub: "CHARACTER:EVE:999", name: "Test Pilot" }),
          refresh_token: "refresh-abc",
          expires_in: 1_209_599,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    })
  );
}

function stateOf(authUrl: string): string {
  return new URL(authUrl).searchParams.get("state") ?? "";
}

describe("EVE_SSO_CALLBACK_URL configuration", () => {
  it("resolves the configured public callback URL and path", () => {
    expect(getCallbackConfig()).toEqual({
      url: PUBLIC_CALLBACK_URL,
      path: "/galaxy/callback",
      explicit: true,
    });
  });

  it("falls back to the local localhost:8085 default when unset", () => {
    const original = process.env.EVE_SSO_CALLBACK_URL;
    delete process.env.EVE_SSO_CALLBACK_URL;
    try {
      expect(getCallbackConfig()).toEqual({
        url: "http://localhost:8085/callback",
        path: "/callback",
        explicit: false,
      });
    } finally {
      process.env.EVE_SSO_CALLBACK_URL = original;
    }
  });

  it("rejects values that are not absolute http(s) URLs with a path", () => {
    for (const value of ["not-a-url", "https://galaxy.example.net", "ftp://galaxy.example.net/cb"]) {
      expect(() => {
        const original = process.env.EVE_SSO_CALLBACK_URL;
        process.env.EVE_SSO_CALLBACK_URL = value;
        try {
          getCallbackConfig();
        } finally {
          process.env.EVE_SSO_CALLBACK_URL = original;
        }
      }).toThrow();
    }
  });
});

describe("OAuth login flow with a public callback URL", () => {
  it("builds the authorization URL against the configured callback", () => {
    const { authUrl } = startLoginFlow("client-123", ["scope.a"]);
    const url = new URL(authUrl);
    expect(url.origin).toBe("https://login.eveonline.com");
    expect(url.pathname).toBe("/v2/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(PUBLIC_CALLBACK_URL);
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toBe("scope.a");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(stateOf(authUrl)).toHaveLength(32);
  });

  it("completes the callback through the main HTTP server and exchanges the code", async () => {
    // The flow started in the previous test is still pending; starting a new
    // flow supersedes it (its promise rejects).
    const superseded = waitForLogin().catch((err: Error) => err.message);
    stubTokenEndpoint();

    const { authUrl } = startLoginFlow("client-123", ["scope.a"]);
    const login = waitForLogin();
    const state = stateOf(authUrl);
    expect(await superseded).toBe("Login flow superseded by new login attempt");

    const response = await fetch(
      `${endpoint}/galaxy/callback?code=auth-code&state=${encodeURIComponent(state)}`
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Authentication Successful");
    expect(html).toContain("Test Pilot");

    const result = await login;
    expect(result.character).toEqual({ characterId: 999, characterName: "Test Pilot", scopes: "scope.a" });
    expect(result.tokens.accessToken).toContain(".");
    expect(result.tokens.refreshToken).toBe("refresh-abc");
    // EVE SSO requires the token exchange redirect_uri to match the auth URL.
    expect(lastExchangeRedirectUri).toBe(PUBLIC_CALLBACK_URL);
  });

  it("rejects a callback with a mismatched state (CSRF protection)", async () => {
    startLoginFlow("client-123");
    const login = waitForLogin();
    const rejected = login.catch((err: Error) => err.message);

    const response = await fetch(`${endpoint}/galaxy/callback?code=auth-code&state=wrong-state`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid state parameter");
    expect(await rejected).toBe("Invalid state — possible CSRF");
  });

  it("returns an error when no login flow is pending", async () => {
    const response = await fetch(`${endpoint}/galaxy/callback?code=auth-code&state=abc`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("No login in progress");
  });

  it("surfaces the OAuth error parameter from EVE SSO", async () => {
    const { authUrl } = startLoginFlow("client-123");
    const state = stateOf(authUrl);
    const login = waitForLogin();
    const rejected = login.catch((err: Error) => err.message);

    const response = await fetch(
      `${endpoint}/galaxy/callback?error=access_denied&state=${encodeURIComponent(state)}`
    );
    expect(response.status).toBe(400);
    expect(await rejected).toBe("OAuth error: access_denied");
  });
});

describe("local development default", () => {
  it("builds authorization URLs for the localhost:8085 callback when the env var is unset", () => {
    const original = process.env.EVE_SSO_CALLBACK_URL;
    delete process.env.EVE_SSO_CALLBACK_URL;
    try {
      const authUrl = buildAuthorizeUrl(
        "client-123",
        "http://localhost:8085/callback",
        ["scope.a"],
        "challenge",
        "state-123"
      );
      const url = new URL(authUrl);
      expect(url.origin).toBe("https://login.eveonline.com");
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8085/callback");
      expect(url.searchParams.get("state")).toBe("state-123");
      expect(url.searchParams.get("code_challenge")).toBe("challenge");
    } finally {
      process.env.EVE_SSO_CALLBACK_URL = original;
    }
  });
});
