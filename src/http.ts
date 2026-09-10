#!/usr/bin/env node

import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closeAuthDb } from "./auth/tokens.js";
import { closeDatabase, sdeExists } from "./database.js";
import { downloadSde } from "./downloader.js";
import { createMcpServer, SERVER_INFO } from "./server.js";
import { beginForeground } from "./work-priority.js";
import { startKeepWarm,stopKeepWarm } from "./keep-warm.js";

const host = process.env.HOST || "127.0.0.1";
const port = parsePort(process.env.PORT);

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? 3000);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return parsed;
}

export const app = express();
app.disable("x-powered-by");
app.use((_req,res,next)=>{
  const done=beginForeground();
  res.once("finish",done);res.once("close",done);next();
});
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  console.log(
    JSON.stringify({
      event: "http_request",
      requestId,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip,
      cfRay: req.get("cf-ray") ?? null,
      userAgent: req.get("user-agent") ?? null,
      rpc: req.path === "/mcp" ? req.body : undefined,
    })
  );

  res.on("finish", () => {
    console.log(
      JSON.stringify({
        event: "http_response",
        requestId,
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        contentType: res.getHeader("content-type") ?? null,
      })
    );
  });

  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version });
});

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP server error" },
        id: req.body?.id ?? null,
      });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

app.all("/mcp", (_req, res) => {
  res.set("Allow", "POST").status(405).json({ error: "Method not allowed" });
});

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  console.error("Unhandled HTTP error", error);
  res.status(500).json({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal MCP server error" },
    id: req.body?.id ?? null,
  });
});

async function prepareData(): Promise<void> {
  if (sdeExists()) return;
  process.stderr.write("SDE database not found. Downloading from Fuzzwork...\n");
  process.stderr.write(`${await downloadSde()}\n`);
}

export async function startHttpServer() {
  await prepareData();
  return app.listen(port, host, () => {
    startKeepWarm();
    console.log(`EVE SDE MCP listening on http://${host}:${port}`);
  });
}

const isMainModule =
  process.env.pm_id !== undefined ||
  (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]));
if (isMainModule) {
  const httpServer = await startHttpServer();
  const shutdown = (signal: string) => {
    stopKeepWarm();
    console.log(`Received ${signal}; shutting down.`);
    httpServer.close(() => {
      closeDatabase();
      closeAuthDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
