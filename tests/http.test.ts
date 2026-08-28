import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
