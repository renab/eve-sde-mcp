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
import { registerNexumTools } from "./tools/nexum.js";
import { registerEntityContextTools } from "./tools/entity-context.js";
import { beginForeground } from "./work-priority.js";
import { enrichStructureToolResult } from "./structures.js";
import { endpointDiscoveryShape } from "./entities.js";
import { createEsiReadContext, withEsiReadContext, enrichRelatedToolResult } from "./esi-related.js";

export const SERVER_INFO = {
  name: "eve-sde",
  version: "1.0.0",
} as const;

/** Create a fresh MCP server. HTTP requests require separate server instances. */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  // Central callback boundary covers both stdio and HTTP without changing tool results.
  const register=server.tool.bind(server);
  let enrichEsiResults=false;
  let relatedEsiReads=false;
  server.tool=((...args:any[])=>{
    const callback=args[args.length-1];
    const enrich=enrichEsiResults && String(args[0]).startsWith("get_") && args[0]!=="get_structure";
    const related=relatedEsiReads && (String(args[0]).startsWith("get_") || args[0]==="check_skill_requirements");
    if (related) {
      args[2]={...endpointDiscoveryShape,...args[2]};
      args[1]+=" Includes bounded current related-record pointers by default; matching uses returned entity IDs and request context. No extra ESI calls for record discovery.";
    }
    args[args.length-1]=async(...values:any[])=>{
      const done=beginForeground();
      try{
        const context=createEsiReadContext();
        const result=await (related && values[0]?.include_related!==false
          ? withEsiReadContext(context,()=>callback(...values)) : callback(...values));
        const enriched=enrich ? await enrichStructureToolResult(result,values[0]?.character_id):result;
        return related ? enrichRelatedToolResult(enriched,values[0] ?? {},context):enriched;
      }finally{done();}
    };
    return (register as (...args:any[])=>any)(...args);
  }) as typeof server.tool;

  registerTypeTools(server);
  registerGroupTools(server);
  registerUniverseTools(server);
  registerIndustryTools(server);
  registerMetaTools(server);
  registerAuthTools(server);
  relatedEsiReads=true;
  registerSkillTools(server);
  enrichEsiResults=true;
  registerMarketTools(server);
  registerIndustryEsiTools(server);
  registerFittingTools(server);
  registerKillmailTools(server);
  registerLoyaltyTools(server);
  registerNavigationTools(server);
  registerPlanetaryTools(server);
  registerDailyTools(server);
  registerOperationTools(server);
  enrichEsiResults=false;
  relatedEsiReads=false;
  registerPersistenceTools(server);
  registerEntityContextTools(server);
  registerKeepWarmTools(server);
  registerNexumTools(server);

  return server;
}
