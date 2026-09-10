import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTypeTools } from "./tools/types.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerUniverseTools } from "./tools/universe.js";
import { registerIndustryTools } from "./tools/industry.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerSkillTools } from "./tools/skills.js";
import { registerMarketTools } from "./tools/market.js";
import { registerIndustryEsiTools } from "./tools/industry-esi.js";
import { registerFittingTools } from "./tools/fittings.js";
import { registerKillmailTools } from "./tools/killmails.js";
import { registerLoyaltyTools } from "./tools/loyalty.js";
import { registerNavigationTools } from "./tools/navigation.js";
import { registerPlanetaryTools } from "./tools/planetary.js";
import { registerDailyTools } from "./tools/daily.js";
import { registerOperationTools } from "./tools/operations.js";
import { registerPersistenceTools } from "./tools/persistence.js";
import { registerKeepWarmTools } from "./tools/keep-warm.js";
import { beginForeground } from "./work-priority.js";

export const SERVER_INFO = {
  name: "eve-sde",
  version: "1.0.0",
} as const;

/** Create a fresh MCP server. HTTP requests require separate server instances. */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  // Central callback boundary covers both stdio and HTTP without changing tool results.
  const register=server.tool.bind(server);
  server.tool=((...args:any[])=>{
    const callback=args[args.length-1];
    args[args.length-1]=async(...values:any[])=>{
      const done=beginForeground();
      try{return await callback(...values);}finally{done();}
    };
    return (register as (...args:any[])=>any)(...args);
  }) as typeof server.tool;

  registerTypeTools(server);
  registerGroupTools(server);
  registerUniverseTools(server);
  registerIndustryTools(server);
  registerMetaTools(server);
  registerAuthTools(server);
  registerSkillTools(server);
  registerMarketTools(server);
  registerIndustryEsiTools(server);
  registerFittingTools(server);
  registerKillmailTools(server);
  registerLoyaltyTools(server);
  registerNavigationTools(server);
  registerPlanetaryTools(server);
  registerDailyTools(server);
  registerOperationTools(server);
  registerPersistenceTools(server);
  registerKeepWarmTools(server);

  return server;
}
