import { afterAll, beforeAll, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openStateDatabase } from "../src/persistence.js";
import { NexumStore } from "../src/nexum-store.js";
import { SecretStore } from "../src/secrets.js";
import { NexumService } from "../src/nexum.js";

const active=vi.hoisted(()=>({service:undefined as any}));
vi.mock("../src/nexum.js",async(original)=>({...await original<typeof import("../src/nexum.js")>(),getNexum:()=>active.service}));
let server:Server,url:string,tmp:string,store:NexumStore;
beforeAll(async()=>{
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),"nexum-http-test-"));store=new NexumStore(openStateDatabase(":memory:"));
  active.service=new NexumService(store,new SecretStore(store.db,path.join(tmp,"key")),{
    get:async()=>({maps:[]}),stream:async()=>{throw new Error("No map expected");}
  });
  const {app}=await import("../src/http.js");await new Promise<void>(r=>server=app.listen(0,"127.0.0.1",r));
  const address=server.address() as any;url=`http://127.0.0.1:${address.port}/mcp`;
});
afterAll(async()=>{await active.service.stop();await new Promise<void>(r=>server.close(()=>r()));store.db.close();fs.rmSync(tmp,{recursive:true,force:true});});
it("enrolls and lists credentials through actual remote MCP HTTP without logging or returning the secret",async()=>{
  const key=crypto.randomBytes(32).toString("base64url");const logs:string[]=[];
  const spy=vi.spyOn(console,"log").mockImplementation((...args)=>logs.push(args.join(" ")));
  try{
    const call=async(name:string,args:any)=>{
      const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
      expect(res.status).toBe(200);return res.text();
    };
    const enrolled=await call("nexum_add_credential",{api_key:key,base_url:"https://nexum.example",label:"McGreggor"});
    expect(enrolled).toContain("McGreggor");expect(enrolled).not.toContain(key);
    const listed=await call("nexum_list_credentials",{});expect(listed).toContain("McGreggor");expect(listed).not.toContain(key);
    expect(logs.join("\n")).not.toContain(key);expect(logs.join("\n")).toContain("[REDACTED]");
    expect(store.credentials()).toHaveLength(1);
  }finally{spy.mockRestore();}
});
