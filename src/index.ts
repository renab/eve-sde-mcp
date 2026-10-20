#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sdeExists, closeDatabase } from "./database.js";
import { closeAuthDb } from "./auth/tokens.js";
import { downloadSde } from "./downloader.js";
import { createMcpServer } from "./server.js";
import { startKeepWarm,stopKeepWarm } from "./keep-warm.js";
import { startNexum,stopNexum } from "./nexum.js";

async function shutdown(): Promise<void> {
  stopKeepWarm();
  await stopNexum();
  closeDatabase();
  closeAuthDb();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

async function main(): Promise<void> {
  if (!sdeExists()) {
    process.stderr.write("SDE database not found. Downloading from Fuzzwork...\n");
    try {
      const msg = await downloadSde();
      process.stderr.write(msg + "\n");
    } catch (err) {
      process.stderr.write(
        `Warning: Failed to auto-download SDE. Use refresh_sde tool manually. Error: ${err}\n`
      );
    }
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  startKeepWarm();
  startNexum();
}

main().catch(async (err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  await shutdown();
  process.exit(1);
});
