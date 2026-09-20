import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { openStateDatabase } from "../../src/persistence.js";
import { NexumStore, canonicalMapId, type Json } from "../../src/nexum-store.js";
import { SecretStore, redactSecrets } from "../../src/secrets.js";
import { NexumService } from "../../src/nexum.js";
import { decodeSse, HttpNexumTransport, NexumError, normalizeBaseUrl, type NexumStream } from "../../src/nexum-client.js";
import { registerNexumTools } from "../../src/tools/nexum.js";

const base="https://nexum.example",mapId=canonicalMapId(base,"map-1"),endpoint="/api/v1/maps/map-1";
const full=()=>({id:"map-1",name:"Wormlife",systems:[{id:"s1",eveSystemId:31000001,name:"J154212",systemClass:"C3",security:-1}],connections:[],routes:[]});
class Feed implements NexumStream {
  private queue:Json[]=[];private wake?:()=>void;closed=false;error?:Error;
  push(e:Json){this.queue.push(e);this.wake?.();}
  close(){this.closed=true;this.wake?.();}
  fail(error:Error){this.error=error;this.close();}
  events=(async function*(this:Feed){while(!this.closed){if(this.queue.length)yield this.queue.shift()!;else await new Promise<void>(r=>this.wake=r);}if(this.error)throw this.error;}).call(this);
}
class Upstream {
  calls:string[]=[];feeds:Feed[]=[];bad=new Set<string>();visible:Json[]=[{id:"map-1",name:"Wormlife"}];
  get=vi.fn(async(_base:string,key:string,url:string)=>{
    this.calls.push(url);if(this.bad.has(key))throw new NexumError(401);
    if(url==="/api/v1/maps")return {maps:structuredClone(this.visible)};
    if(url===endpoint)return full();
    return [{id:"item-1",name:url.split("/").at(-1),eveId:"9007199254740993"}];
  });
  patch=vi.fn(async(_base:string,key:string,_url:string,_body:Record<string,unknown>)=>{
    if(this.bad.has(key))throw new NexumError(403);return {ok:true};
  });
  stream=vi.fn(async(_base:string,key:string,_url:string,signal?:AbortSignal)=>{
    if(this.bad.has(key))throw new NexumError(401);
    const f=new Feed();this.feeds.push(f);signal?.addEventListener("abort",()=>f.close(),{once:true});return f;
  });
  live(){return this.feeds.filter(f=>!f.closed);}
}
let store:NexumStore,secrets:SecretStore,service:NexumService,up:Upstream,tmp:string,key:string;
const until=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}expect(fn()).toBe(true);};
beforeEach(()=>{
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),"galaxy-nexum-test-"));
  store=new NexumStore(openStateDatabase(":memory:"));secrets=new SecretStore(store.db,path.join(tmp,"key"));up=new Upstream();
  service=new NexumService(store,secrets,up,{debounceMs:10,retryMs:10,random:()=>0.5});key=crypto.randomBytes(32).toString("base64url");
});
afterEach(async()=>{await service.stop();store.db.close();fs.rmSync(tmp,{recursive:true,force:true});vi.restoreAllMocks();});
async function enroll(label="McGreggor",api_key=key){const c=await service.addCredential({api_key,label,base_url:base});await until(()=>store.map(mapId).health==="live");return c;}

describe("Nexum credentials and canonical synchronization",()=>{
  it("encrypts secrets, supports unknown/null expiry, and never serializes keys or secret refs",async()=>{
    const c=await enroll();expect(c.expiry).toBeNull();expect(c.expiry_known).toBe(false);expect(c.secret_ref).toBeUndefined();
    expect(JSON.stringify(service.diagnostics())).not.toContain(key);
    expect(JSON.stringify(store.db.prepare("SELECT * FROM galaxy_secrets").all())).not.toContain(key);
    expect(secrets.get(c.id)).toBe(key);
    const reopened=new SecretStore(store.db,path.join(tmp,"key"));expect(reopened.get(c.id)).toBe(key);
  });
  it("two characters share one map, retain both bindings and do not rehydrate on enrollment",async()=>{
    await enroll();up.calls=[];
    await enroll("Minner",crypto.randomBytes(32).toString("base64url"));
    expect(store.maps()).toHaveLength(1);expect(store.access(mapId)).toHaveLength(2);expect(up.live()).toHaveLength(1);
    expect(up.calls).toEqual(["/api/v1/maps"]);
  });
  it("hydrates map plus three narrow resource lists; every ordinary MCP read is cache-only",async()=>{
    await enroll();expect(up.calls).toEqual(["/api/v1/maps",endpoint,...["signatures","anomalies","structures"].map(k=>`${endpoint}/systems/s1/${k}`)]);
    up.calls=[];
    const tools:Record<string,any>={};registerNexumTools({tool:(n:any,_d:any,s:any,h:any)=>{tools[n]={s:z.object(s),h};}} as any,()=>service);
    for(const [n,args]of Object.entries({nexum_list_maps:{},nexum_get_map_state:{map_id:mapId},nexum_get_system_state:{map_id:mapId,system_id_or_name:"J154212"},
      nexum_get_presence:{map_id:mapId},get_wormhole_chain_state:{map_id:"Wormlife",root:"J154212",include_sites:true},nexum_status:{}})){
      const result=await tools[n].h(tools[n].s.parse(args));expect(result.isError).toBeUndefined();expect(JSON.stringify(result)).not.toContain(key);
    }
    expect(up.calls).toEqual([]);expect(service.systemState(mapId,"s1").structures.items[0].eveId).toBe("9007199254740993");
  });
  it("rejects bad keys and insufficient live-event scope before storage",async()=>{
    up.bad.add(key);await expect(service.addCredential({api_key:key,base_url:base})).rejects.toBeInstanceOf(NexumError);
    up.bad.clear();up.stream.mockRejectedValueOnce(new NexumError(403));
    await expect(service.addCredential({api_key:key,base_url:base})).rejects.toBeInstanceOf(NexumError);
    expect(store.credentials()).toEqual([]);expect(store.db.prepare("SELECT * FROM galaxy_secrets").all()).toEqual([]);
  });
  it("revalidation marks revoked credentials unhealthy while retaining cache",async()=>{
    const c=await enroll();up.bad.add(key);const result=await service.testCredential(c.id);
    expect(result.health).toBe("auth_failed");expect(service.mapState(mapId).map.systems).toHaveLength(1);
  });
  it("fails over an unauthorized active credential without duplicate managed streams or losing cache",async()=>{
    const c=await enroll();const other=await enroll("Minner",crypto.randomBytes(32).toString("base64url"));
    up.bad.add(key);up.live()[0].fail(new NexumError(401));
    await until(()=>store.map(mapId).stream_credential_id===other.id&&store.map(mapId).health==="live");
    expect(store.credential(c.id).health).toBe("auth_failed");expect(up.live()).toHaveLength(1);expect(service.mapState(mapId).map.systems).toHaveLength(1);
  });
  it("supports label, disable/enable, replacement, removal and leaves Nexum itself untouched",async()=>{
    const c=await enroll();await service.updateCredential(c.id,{label:"Renab",enabled:false});expect(up.live()).toHaveLength(0);
    const replacement=crypto.randomBytes(32).toString("base64url");await service.updateCredential(c.id,{enabled:true,api_key:replacement});
    await until(()=>store.map(mapId).health==="live");expect(secrets.get(c.id)).toBe(replacement);
    const result=await service.removeCredential(c.id);expect(result.nexum_key_revoked).toBe(false);expect(store.access()).toEqual([]);expect(up.live()).toHaveLength(0);
    expect(()=>secrets.get(c.id)).toThrow();expect(service.mapState(mapId).map.systems).toHaveLength(1);
  });
  it("sets a user-confirmed binding through MCP without accessing secrets, refetching or restarting streams",async()=>{
    const c=await enroll(),feed=up.live()[0],access=store.access(mapId);
    const ciphertext=store.db.prepare("SELECT ciphertext FROM galaxy_secrets WHERE id=?").get(c.id);
    const readSecret=vi.spyOn(secrets,"get"),writeSecret=vi.spyOn(secrets,"put");up.calls=[];up.stream.mockClear();
    const tools:Record<string,any>={};registerNexumTools({tool:(n:any,_d:any,s:any,h:any)=>tools[n]={s:z.object(s),h}} as any,()=>service);
    const args=tools.nexum_update_credential.s.parse({credential_id:c.id,character_id:"9007199254740993"});
    const result=JSON.parse((await tools.nexum_update_credential.h(args)).content[0].text);
    expect(result).toMatchObject({bound_character_id:"9007199254740993",identity_source:"user_confirmed",health:"healthy"});
    expect(service.listCredentials()[0].bound_character_id).toBe("9007199254740993");
    expect(service.listMaps()[0].access[0].character_id).toBe("9007199254740993");
    expect(store.access(mapId)).toEqual(access);expect(up.live()).toEqual([feed]);expect(feed.closed).toBe(false);
    expect(up.calls).toEqual([]);expect(up.stream).not.toHaveBeenCalled();expect(readSecret).not.toHaveBeenCalled();expect(writeSecret).not.toHaveBeenCalled();
    expect(store.db.prepare("SELECT ciphertext FROM galaxy_secrets WHERE id=?").get(c.id)).toEqual(ciphertext);
    await service.updateCredential(c.id,{enabled:true});expect(service.credentialResult(c.id).identity_source).toBe("user_confirmed");expect(up.stream).not.toHaveBeenCalled();
    for(const character_id of ["", "0", "-1", "1.5", "pilot", "01", "123456789012345678901",1320166902])
      expect(tools.nexum_update_credential.s.safeParse({credential_id:c.id,character_id}).success).toBe(false);
    await expect(service.updateCredential(c.id,{character_id:"invalid"})).rejects.toBeInstanceOf(NexumError);
  });
  it("refreshes access bindings when a map disappears",async()=>{
    const c=await enroll();up.visible=[];await service.testCredential(c.id);expect(store.access()).toEqual([]);expect(up.live()).toHaveLength(0);
  });
  it("restarts from persisted credentials and hydrates without caller reads",async()=>{
    await enroll();await service.stop();up.calls=[];
    service=new NexumService(store,secrets,up,{debounceMs:10,retryMs:10});service.start();
    await until(()=>store.map(mapId).health==="live");expect(up.live()).toHaveLength(1);expect(up.calls.filter(c=>c===endpoint)).toHaveLength(1);
  });
  it("uses distinct canonical identities for the same upstream ID on different instances",()=>{
    expect(canonicalMapId(base,"map-1")).not.toBe(canonicalMapId("https://other.example","map-1"));
  });
});

describe("audited event traffic",()=>{
  it("applies every full/delta/delete event directly with zero REST calls",async()=>{
    const c=await enroll();up.calls=[];
    const events=[{type:"system.add",system:{id:"s2",name:"J123456",eveSystemId:31000002}},
      {type:"system.update",id:"s2",updates:{notes:"scouted",futureField:42}},
      {type:"connection.add",connection:{id:"c1",sourceId:"s1",targetId:"s2",type:"N110"}},
      {type:"connection.update",id:"c1",updates:{massStatus:"critical",broken:true}},
      {type:"route.add",route:{id:"r1",systemIds:["s1","s2"]}},{type:"route.update",id:"r1",updates:{name:"Exit"}},
      {type:"route.reorder",orderedIds:["r1"]},{type:"map.meta",name:"Wormlife updated",locked:true},
      {type:"presence.snapshot",viewers:[]},{type:"presence.update",characterId:1,characterName:"McGreggor",eveSystemId:31000002,shipTypeId:null,ts:1},
      {type:"presence.leave",characterId:1},{type:"kill.recent",killmailId:"9007199254740993"},
      {type:"jump.logged",connectionId:"c1",jump:{id:"j1",connectionId:"c1",hot:false}},
      {type:"jump.updated",connectionId:"c1",jump:{id:"j1",connectionId:"c1",hot:true}},
      {type:"jump.cleared",connectionId:"c1"},{type:"connection.remove",id:"c1"},{type:"route.remove",id:"r1"},
      {type:"system.remove",id:"s2"},{type:"__heartbeat"},{type:"future.event",future:{id:1}}];
    for(const event of events){await service.handleEvent(mapId,event,store.credential(c.id));expect(up.calls).toEqual([]);}
    expect(store.state(mapId).systems).toHaveLength(1);expect(store.state(mapId).connections).toEqual([]);expect(store.state(mapId).locked).toBe(true);
  });
  it.each([["sig.changed","signatures"],["anom.changed","anomalies"],["structure.changed","structures"]])("%s burst makes exactly one targeted %s GET",async(type,kind)=>{
    const c=await enroll();up.calls=[];
    for(let i=0;i<20;i++)await service.handleEvent(mapId,{type,systemId:"s1"},store.credential(c.id));
    await until(()=>up.calls.length>0);await new Promise(r=>setTimeout(r,30));
    expect(up.calls).toEqual([`${endpoint}/systems/s1/${kind}`]);
  });
  it("resync does only one full map and the omitted per-system intel, coalescing a burst",async()=>{
    const c=await enroll();up.calls=[];
    for(let i=0;i<10;i++)await service.handleEvent(mapId,{type:"map.resync"},store.credential(c.id));
    await until(()=>up.calls.length===3);expect(up.calls).toEqual([endpoint,...["signatures","structures"].map(k=>`${endpoint}/systems/s1/${k}`)]);
    expect(store.resources(mapId,"s1").anomalies.items).toHaveLength(1);
  });
  it("resync absorbs simultaneous resource invalidations",async()=>{
    const c=await enroll();up.calls=[];
    await service.handleEvent(mapId,{type:"sig.changed",systemId:"s1"},store.credential(c.id));
    await service.handleEvent(mapId,{type:"map.resync"},store.credential(c.id));
    await service.handleEvent(mapId,{type:"structure.changed",systemId:"s1"},store.credential(c.id));
    await until(()=>up.calls.length===3);await new Promise(r=>setTimeout(r,25));expect(up.calls).toHaveLength(3);
  });
  it("does not lose an independent anomaly invalidation during a merge resync",async()=>{
    const c=await enroll();up.calls=[];
    await service.handleEvent(mapId,{type:"map.resync"},store.credential(c.id));
    await service.handleEvent(mapId,{type:"anom.changed",systemId:"s1"},store.credential(c.id));
    await until(()=>up.calls.length===4);expect(up.calls.filter(p=>p.endsWith("/anomalies"))).toHaveLength(1);
  });
  it("a targeted auth failure fails over and recovers without waiting for another event",async()=>{
    const c=await enroll();const other=await enroll("Minner",crypto.randomBytes(32).toString("base64url"));up.bad.add(key);
    up.live()[0].push({type:"sig.changed",systemId:"s1"});
    await until(()=>store.map(mapId).stream_credential_id===other.id&&store.map(mapId).health==="live");
    expect(store.credential(c.id).health).toBe("auth_failed");
  });
  it("reconnect reloads missed state and transitions degraded -> live",async()=>{
    await enroll();up.calls=[];up.live()[0].close();await until(()=>store.map(mapId).health==="degraded");
    await until(()=>store.map(mapId).health==="live");expect(up.calls.filter(c=>c===endpoint)).toHaveLength(1);expect(up.calls).toHaveLength(4);
  });
  it("buffers topology events during initial hydration instead of losing the handoff",async()=>{
    const original=up.get.getMockImplementation()!;
    up.get.mockImplementation(async(b,k,p)=>{if(p===endpoint)up.live()[0].push({type:"system.update",id:"s1",updates:{notes:"during hydration"}});return original(b,k,p);});
    await enroll();expect(store.state(mapId).systems[0].notes).toBe("during hydration");
  });
  it("ignores malformed payloads without crashing or requesting a full map",async()=>{
    const c=await enroll();up.calls=[];
    for(const e of [null,{}, {type:"system.add"},{type:"presence.snapshot",viewers:[null]},{type:"sig.changed"},{type:"route.reorder"}])
      await service.handleEvent(mapId,e as any,store.credential(c.id));
    expect(up.calls).toEqual([]);expect(store.state(mapId).systems).toHaveLength(1);
  });
});

describe("chain identifier reconciliation",()=>{
  it("writes only a changed directional signature note and updates the local cache before its echo",async()=>{
    const c=await enroll();up.calls=[];
    await service.handleEvent(mapId,{type:"system.update",id:"s1",updates:{isHome:true}},store.credential(c.id));
    await service.handleEvent(mapId,{type:"system.add",system:{id:"s2",name:"J223207",eveSystemId:31000002,systemClass:"C2",customLabels:[]}},store.credential(c.id));
    store.saveResource(mapId,"s1","signatures",[{id:"h1",notes:"wrong"}]);store.saveResource(mapId,"s2","signatures",[{id:"b1",notes:""}]);
    await service.handleEvent(mapId,{type:"connection.add",connection:{id:"c1",sourceId:"s1",targetId:"s2",connectionType:"standard",sourceSignatureId:"h1",targetSignatureId:"b1",broken:false}},store.credential(c.id));
    await until(()=>up.patch.mock.calls.length===2);
    expect(up.patch).toHaveBeenCalledWith(base,key,`${endpoint}/systems/s1/signatures/h1`,{notes:"A"},expect.anything());
    expect(up.patch).toHaveBeenCalledWith(base,key,`${endpoint}/systems/s2/signatures/b1`,{notes:"H"},expect.anything());
    expect(store.resources(mapId,"s1").signatures.items[0].notes).toBe("A");
    await new Promise(r=>setTimeout(r,30));expect(up.patch).toHaveBeenCalledTimes(2);
    expect(service.chainDiagnostics(mapId).custom_label_write).toMatch(/unavailable_by_external_api/);
  });
  it("keeps reads/live state healthy when a content-write key is refused",async()=>{
    const c=await enroll();up.bad.add(key);
    await service.handleEvent(mapId,{type:"system.update",id:"s1",updates:{isHome:true}},store.credential(c.id));
    await service.handleEvent(mapId,{type:"system.add",system:{id:"s2",name:"J223207",eveSystemId:31000002,systemClass:"C2"}},store.credential(c.id));
    store.saveResource(mapId,"s1","signatures",[{id:"h1",notes:""}]);
    await service.handleEvent(mapId,{type:"connection.add",connection:{id:"c1",sourceId:"s1",targetId:"s2",connectionType:"standard",sourceSignatureId:"h1",broken:false}},store.credential(c.id));
    await until(()=>store.credential(c.id).chain_write_status==="unavailable");
    expect(store.credential(c.id).health).toBe("healthy");expect(service.mapState(mapId).map.systems).toHaveLength(2);
  });
  it("falls back from a known-unwritable stream key to another authorized writer",async()=>{
    const read=await enroll();const writer=await enroll("Writer",crypto.randomBytes(32).toString("base64url"));
    store.patchCredential(read.id,{chain_write_status:"unavailable"});
    await service.handleEvent(mapId,{type:"system.update",id:"s1",updates:{isHome:true}},store.credential(read.id));
    await service.handleEvent(mapId,{type:"system.add",system:{id:"s2",name:"J223207",eveSystemId:31000002,systemClass:"C2"}},store.credential(read.id));
    store.saveResource(mapId,"s1","signatures",[{id:"h1",notes:""}]);
    await service.handleEvent(mapId,{type:"connection.add",connection:{id:"c1",sourceId:"s1",targetId:"s2",connectionType:"standard",sourceSignatureId:"h1",broken:false}},store.credential(read.id));
    await until(()=>up.patch.mock.calls.length===1);
    expect(up.patch.mock.calls[0][1]).toBe(secrets.get(writer.id));expect(store.credential(writer.id).chain_write_status).toBe("available");
  });
});

describe("presence and freshness",()=>{
  it("keeps every snapshot viewer and subsequent character update, regardless of the stream credential",async()=>{
    const c=await enroll("Naffin Minner");await service.updateCredential(c.id,{character_id:"1320166902"});
    up.calls=[];const feed=up.live()[0];
    const viewers=[
      {characterId:"641570826",characterName:"Naffin McGreggor",eveSystemId:31000398,shipTypeId:null,ts:Date.now()},
      {characterId:"1320166902",characterName:"Naffin Minner",eveSystemId:31000398,shipTypeId:null,ts:Date.now()},
      {characterId:"2124658640",characterName:"Renab Naf",eveSystemId:31000398,shipTypeId:null,ts:Date.now()},
    ];
    feed.push({type:"presence.snapshot",viewers});
    await until(()=>service.presence(mapId).presence.length===3);
    expect(service.presence(mapId,{system:"31000398"}).presence.map((p:Json)=>p.characterId).sort()).toEqual(viewers.map(p=>p.characterId).sort());
    expect(service.presence(mapId).presence_coverage).toMatchObject({scope:"map_viewers",includes_account_character_locations:false});
    expect(service.systemState(mapId,"s1").presence_coverage).toEqual(service.presence(mapId).presence_coverage);
    expect(service.chain(mapId,{include_presence:true}).presence_coverage).toEqual(service.presence(mapId).presence_coverage);
    feed.push({type:"presence.update",actor:"another-browser",...viewers[2],eveSystemId:31000002});
    await until(()=>service.presence(mapId,{character:"2124658640"}).presence[0]?.eveSystemId===31000002);
    expect(service.presence(mapId).presence).toHaveLength(3);
    expect(service.presence(mapId,{current_only:false,character:"2124658640"}).presence.map((p:Json)=>p.eveSystemId)).toEqual([31000398,31000002]);
    feed.push({type:"presence.leave",characterId:"641570826"});
    await until(()=>service.presence(mapId).presence.length===2);
    expect(service.presence(mapId).presence.map((p:Json)=>p.characterId).sort()).toEqual(["1320166902","2124658640"]);
    expect(up.calls).toEqual([]);
  });
  it("records transitions, suppresses heartbeat snapshots, retains baseline and prunes beyond 48h",async()=>{
    await enroll();let time=Date.now();const clockStore=new NexumStore(store.db,()=>time);
    const viewer={characterId:"9007199254740993",characterName:"McGreggor",eveSystemId:31000001,shipTypeId:1,ts:time};
    clockStore.presence(mapId,{type:"presence.snapshot",viewers:[viewer]});time+=1000;
    clockStore.presence(mapId,{type:"presence.update",...viewer,ts:time});expect(clockStore.history(mapId)).toHaveLength(1);
    time+=1000;clockStore.presence(mapId,{type:"presence.update",...viewer,eveSystemId:31000002,ts:time});
    expect(clockStore.currentPresence(mapId)[0].eveSystemId).toBe(31000002);
    expect(clockStore.history(mapId,time-500).map(p=>p.baseline)).toEqual([true,false]);
    time+=1000;clockStore.presence(mapId,{type:"presence.snapshot",viewers:[]});expect(clockStore.currentPresence(mapId)).toEqual([]);
    expect(clockStore.history(mapId).at(-1)?.event).toBe("presence.leave");
    time+=49*3600_000;clockStore.prune(48*3600_000);expect(clockStore.history(mapId)).toEqual([]);
    expect(store.db.prepare("SELECT * FROM records").all()).toEqual([]);
  });
  it("keeps stale cached data readable with an explicit warning",async()=>{
    await enroll();store.patchMap(mapId,{stream_connected:false,health:"degraded",disconnected_at:Date.now()-3600_000});
    const result=service.mapState(mapId);expect(result.freshness.health).toBe("stale");expect(result.freshness.warning).toBeTruthy();expect(result.map.systems).toHaveLength(1);
  });
  it("keeps a labeled retention baseline for unchanged long-running presence",async()=>{
    await enroll();let time=Date.now();const clockStore=new NexumStore(store.db,()=>time);
    clockStore.presence(mapId,{type:"presence.update",characterId:1,eveSystemId:31000001,ts:time});
    const observed=time;time+=49*3600_000;clockStore.prune(48*3600_000);
    const baseline=clockStore.history(mapId);expect(baseline).toHaveLength(1);expect(baseline[0]).toMatchObject({event:"presence.baseline",baseline_from:observed,eveSystemId:31000001});
    expect(baseline[0].observed_at).toBe(time-48*3600_000);
    clockStore.presence(mapId,{type:"presence.leave",characterId:1});time+=49*3600_000;clockStore.prune(48*3600_000);expect(clockStore.history(mapId)).toEqual([]);
  });
});

describe("remote tool security and SSE transport",()=>{
  it("redacts complete credential tool args in single and batched request logs",()=>{
    const request={method:"tools/call",params:{name:"nexum_add_credential",arguments:{api_key:key,label:key}}};
    expect(JSON.stringify(redactSecrets([request,{nested:{api_key:key,authorization:`Bearer ${key}`}}]))).not.toContain(key);
    expect(redactSecrets({params:{name:"nexum_update_credential",arguments:{api_key:key}}}).params.arguments).toBe("[REDACTED]");
  });
  it("remote MCP enrollment returns safe metadata, including for upstream failures",async()=>{
    const tools:Record<string,any>={};registerNexumTools({tool:(n:any,_d:any,s:any,h:any)=>tools[n]={s:z.object(s),h}} as any,()=>service);
    const result=await tools.nexum_add_credential.h({api_key:key,base_url:base});expect(result.isError).toBeUndefined();expect(JSON.stringify(result)).not.toContain(key);
    up.get.mockRejectedValueOnce(new Error(key));const failed=await tools.nexum_test_credential.h({credential_id:JSON.parse(result.content[0].text).id});expect(JSON.stringify(failed)).not.toContain(key);
  });
  it("parses fragmented unnamed frames, comments, malformed JSON and 64-bit-safe IDs",async()=>{
    const encoder=new TextEncoder();const body=new ReadableStream<Uint8Array>({start(c){for(const s of [": ping\r\n\r\nda","ta: {\"type\":\"presence.leave\",\"characterId\":9007199254740993}\r\n\r\n","data: bad\n\n"])c.enqueue(encoder.encode(s));c.close();}});
    const rows=[];for await(const e of decodeSse(body,new AbortController().signal))rows.push(e);
    expect(rows).toEqual([{type:"__heartbeat"},{type:"presence.leave",characterId:"9007199254740993"},{type:"malformed"}]);
  });
  it("uses only GET Bearer calls, refuses redirects and respects Retry-After without reflecting response bodies",async()=>{
    const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(key,{status:429,headers:{"Retry-After":"12"}}));
    await expect(new HttpNexumTransport().get(base,key,"/api/v1/maps")).rejects.toMatchObject({status:429,retryAfterMs:12000,message:"Nexum HTTP 429"});
    expect(fetcher).toHaveBeenCalledWith(base+"/api/v1/maps",expect.objectContaining({redirect:"error",headers:expect.objectContaining({Authorization:`Bearer ${key}`})}));
    expect(normalizeBaseUrl(base+"/")).toBe(base);expect(()=>normalizeBaseUrl("http://example.com")).toThrow();expect(()=>normalizeBaseUrl(`https://${key}@example.com`)).toThrow();
  });
});
