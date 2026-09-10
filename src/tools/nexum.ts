import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getNexum, type NexumService } from "../nexum.js";
import { NexumError } from "../nexum-client.js";

const id=z.string().min(1).max(512);
const secret=z.string().min(1).max(4096).describe("Secret Nexum Bearer key. Never echo, log or save in notes. Choose Read + live events in Nexum.");
export function registerNexumTools(server:McpServer, getService:()=>NexumService=getNexum):void {
  const tool=(name:string,description:string,schema:Record<string,z.ZodType>,fn:(s:NexumService,args:any)=>any)=>{
    server.tool(name,description,schema,async(args:any)=>{
      try {return {content:[{type:"text" as const,text:JSON.stringify(await fn(getService(),args))}]};}
      catch(e){return {isError:true,content:[{type:"text" as const,text:JSON.stringify({error:e instanceof NexumError?e.message:"Nexum operation failed; check IDs and nexum_status. No credential values are returned."})}]};}
    });
  };
  tool("nexum_add_credential","Remotely validate and securely enroll a Nexum Read + live events key. Supports non-expiring keys. No local setup required. Character ID is caller-supplied; API cannot verify identity/expiry/exact scope.",
    {api_key:secret,character_id:id.optional(),label:z.string().max(160).optional(),base_url:z.string().max(2048).optional()},(s,a)=>s.addCredential(a));
  tool("nexum_list_credentials","List safe Nexum credential metadata; never returns keys.",{},s=>s.listCredentials());
  tool("nexum_test_credential","Revalidate a stored Nexum key and discover map access and live-event capability.",{credential_id:id},(s,a)=>s.testCredential(a.credential_id));
  tool("nexum_update_credential","Update Nexum label/enabled state or securely validate and replace its key.",
    {credential_id:id,label:z.string().max(160).optional(),enabled:z.boolean().optional(),api_key:secret.optional()},(s,a)=>s.updateCredential(a.credential_id,a));
  tool("nexum_remove_credential","Remove Galaxy's stored key and access bindings. This does NOT revoke the key in Nexum.",{credential_id:id},(s,a)=>s.removeCredential(a.credential_id));
  tool("nexum_list_maps","List canonical locally cached Nexum maps, freshness, and character access bindings. Zero upstream calls.",{},s=>s.listMaps());
  tool("nexum_get_map_state","Read local Nexum map metadata, systems, connections and freshness. Zero upstream calls.",{map_id:id},(s,a)=>s.mapState(a.map_id));
  tool("nexum_get_system_state","Read cached system, signatures, anomalies, structures, connections and viewer presence.",
    {map_id:id,system_id_or_name:id},(s,a)=>s.systemState(a.map_id,a.system_id_or_name));
  tool("nexum_get_presence","Read current or retained 48h viewer presence telemetry. Historical results include a pre-since baseline when retained. Never treat inferred location as an explicit user report.",
    {map_id:id,character:id.optional(),system:id.optional(),current_only:z.boolean().optional(),since:z.iso.datetime().optional()},
    (s,a)=>s.presence(a.map_id,{...a,since:a.since?Date.parse(a.since):undefined}));
  tool("get_wormhole_chain_state","Compact canonical Nexum chain from local cache. Accepts map ID or unique map name. Unknown fields are omitted; includes freshness.",
    {map_id:id,root:id.optional(),depth:z.number().int().min(0).max(30).optional(),include_presence:z.boolean().optional(),include_sites:z.boolean().optional()},(s,a)=>s.chain(a.map_id,a));
  tool("nexum_status","Safe Nexum diagnostics: credentials, access, streams, reconnects, freshness and presence history count.",{},s=>s.diagnostics());
}
