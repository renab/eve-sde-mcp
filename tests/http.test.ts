import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server;
let endpoint: string;

beforeAll(async () => {
  const { app } = await import("../src/http.js");
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("HTTP bridge", () => {
  it("offers an unauthenticated health probe without leaking configuration", async () => {
    const response = await fetch(`${endpoint}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, name: "eve-sde", version: "1.0.0" });
  });

  it("accepts an MCP initialize request without origin authentication", async () => {
    const response = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "http-bridge-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("eve-sde");
    expect(body).toContain("protocolVersion");
  });
});

describe("HTTP startup lifecycle", () => {
  it("propagates a service initialization failure and closes the listener and already-started services", async () => {
    const initializationFailure = new Error("WormholeSystems scheduler initialization failed");
    const startKeepWarm = vi.fn();
    const stopKeepWarm = vi.fn();
    const startNexum = vi.fn();
    const stopNexum = vi.fn(async () => undefined);
    const startWormholeSystemsSync = vi.fn(() => { throw initializationFailure; });
    const stopWormholeSystems = vi.fn(async () => undefined);
    const close = vi.fn((callback: () => void) => callback());
    const listener = Object.assign(new EventEmitter(), { close }) as unknown as Server;

    vi.resetModules();
    vi.doMock("../src/database.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/database.js")>(), sdeExists: () => true }));
    vi.doMock("../src/keep-warm.js", () => ({ startKeepWarm, stopKeepWarm }));
    vi.doMock("../src/nexum.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/nexum.js")>(), startNexum, stopNexum }));
    vi.doMock("../src/wormholesystems.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/wormholesystems.js")>(), startWormholeSystemsSync, stopWormholeSystems }));
    try {
      const { app, startHttpServer } = await import("../src/http.js");
      const listen = vi.spyOn(app, "listen").mockImplementation(() => {
        queueMicrotask(() => listener.emit("listening"));
        return listener;
      });
      await expect(startHttpServer()).rejects.toBe(initializationFailure);
      expect(listen).toHaveBeenCalledOnce();
      expect(startKeepWarm).toHaveBeenCalledOnce();
      expect(startNexum).toHaveBeenCalledOnce();
      expect(startWormholeSystemsSync).toHaveBeenCalledOnce();
      expect(stopWormholeSystems).toHaveBeenCalledOnce();
      expect(stopKeepWarm).toHaveBeenCalledOnce();
      expect(stopNexum).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      vi.doUnmock("../src/database.js");
      vi.doUnmock("../src/keep-warm.js");
      vi.doUnmock("../src/nexum.js");
      vi.doUnmock("../src/wormholesystems.js");
      vi.resetModules();
    }
  });
});
