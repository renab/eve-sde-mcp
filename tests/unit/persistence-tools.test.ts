import { beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerPersistenceTools } from "../../src/tools/persistence.js";

describe("persistence MCP interface",()=>{
  const tools: Record<string,{ schema:z.ZodObject<any>; handler:(args:any)=>Promise<any> }>={};
  beforeEach(()=>registerPersistenceTools({tool:(name:string,_description:string,schema:any,handler:any)=>{tools[name]={schema:z.object(schema),handler};}} as unknown as McpServer));
  const call=async(name:string,args:unknown)=>JSON.parse((await tools[name].handler(tools[name].schema.parse(args))).content[0].text);
  it("round-trips store, correction, lookup, search, history and recap through MCP handlers",async()=>{
    const input={namespace:"test",kind:"new_kind",key:"one",payload:{value:1}};
    const first=await call("store_record",input);
    const next=await call("supersede_record",{...input,payload:{value:2,brand_new_field:true},supersedes_id:first.id});
    expect((await call("get_record",{namespace:"test",kind:"new_kind",key:"one"})).record.id).toBe(next.id);
    expect((await call("search_records",{namespace:"test"})).total).toBe(1);
    expect((await call("get_record_history",{namespace:"test",id:first.id})).records).toHaveLength(2);
    expect((await call("describe_record_kind",{namespace:"test",kind:"new_kind"})).fields).toEqual(expect.arrayContaining([expect.objectContaining({path:"payload.brand_new_field"})]));
    const projection=await call("render_recap",{namespace:"test",mode:"run",id:first.id,filepath:"test.md"});
    expect(projection.recordIds).toEqual([next.id]); expect(projection.publicationRequired).toBe(true);
  });
  it("round-trips generic relationships",async()=>{
    await call("link_records",{namespace:"test",from_key:"a",relation:"USED",to_key:"b"});
    expect((await call("search_relationships",{namespace:"test",to_key:"b"})).relationships).toHaveLength(1);
  });
});
