import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {openStateDatabase} from "../../src/persistence.js";
import {NexumStore,canonicalMapId} from "../../src/nexum-store.js";
import {NexumService} from "../../src/nexum.js";
import type {LocationProvider} from "../../src/nexum-esi.js";
vi.mock("../../src/work-priority.js",async original=>({...await original<any>(),isIdle:()=>true,
  runBackground:async(fn:()=>Promise<any>)=>fn()}));
let store:NexumStore,service:NexumService,now:number,source:LocationProvider;
const map=canonicalMapId("https://example.com","a"),map2=canonicalMapId("https://example.com","b");
beforeEach(()=>{
  now=Date.now();store=new NexumStore(openStateDatabase(":memory:"),()=>now);
  source={characters:()=>[1,2,3].map(id=>({characterId:id,characterName:`Pilot ${id}`,scopes:"esi-location.read_location.v1"})),
    read:vi.fn(async()=>({data:{solar_system_id:31000398},metadata:{esiFetchedAt:new Date(now).toISOString(),localCacheExpiresAt:new Date(now+60_000).toISOString(),cacheStatus:"esi_response"}}))};
  for(const id of [1,2,3]){const c={id:String(id),bound_character_id:String(id),enabled:true,base_url:"https://example.com"};
    store.saveCredential(c);store.discover(c,[{id:"a",name:"A"},{id:"b",name:"B"}]);}
  for(const id of [map,map2])store.saveState(id,{systems:[{id:"s",name:"J154212",eveSystemId:31000398}],connections:[]});
  service=new NexumService(store,{} as any,{} as any,{},source);service.esiLocations.start();
});
afterEach(async()=>{await service.stop();store.db.close();vi.restoreAllMocks();});
async function sampleAll(){for(let i=0;i<3;i++)await service.esiLocations.tick();}
it("shares three character reads across maps and keeps all MCP reads cache-only",async()=>{
  await sampleAll();expect(source.read).toHaveBeenCalledTimes(3);
  store.presence(map,{type:"presence.snapshot",viewers:[{characterId:2,characterName:"Pilot 2",eveSystemId:31000398,ts:now+1}]});
  const result=service.presence(map);expect(result.presence).toHaveLength(3);
  expect(result.presence.find((p:any)=>String(p.characterId)==="2").observations).toHaveLength(2);
  expect(service.presence(map2).presence).toHaveLength(3);
  expect(service.systemState(map,"s").presence).toHaveLength(3);
  expect(service.chain(map,{include_presence:true}).presence).toHaveLength(3);
  await sampleAll();expect(source.read).toHaveBeenCalledTimes(3);
  expect(result.presence.find((p:any)=>p.characterId==="1")).toMatchObject({online:null,provenance:"esi_location",stale:false});
  store.presence(map,{type:"presence.snapshot",viewers:[]});expect(service.presence(map).presence).toHaveLength(3);
});
it("retains conflicting evidence and records moves out of the map without inventing online status",async()=>{
  await sampleAll();store.presence(map,{type:"presence.update",characterId:1,eveSystemId:31000398,ts:now});
  now+=61_000;source.read=vi.fn(async()=>({data:{solar_system_id:30000142},metadata:{esiFetchedAt:new Date(now).toISOString(),localCacheExpiresAt:null,cacheStatus:"esi_response"}}));
  await sampleAll();const p=service.presence(map,{character:"1"}).presence[0];
  expect(p).toMatchObject({eveSystemId:30000142,in_map:false,location_conflict:true,stale:true,online:null});
  expect(p.observations).toHaveLength(2);expect(service.systemState(map,"s").presence).toHaveLength(0);
  const history=service.presence(map,{character:"1",current_only:false}).presence;
  expect(history.filter((p:any)=>p.provenance==="esi_location").map((p:any)=>p.eveSystemId)).toEqual([31000398,30000142]);
});
it("does not renew observations on errors; redacts errors and stops using removed authorization/bindings",async()=>{
  await sampleAll();now+=61_000;source.read=vi.fn(async()=>{throw new Error("secret-token")});await sampleAll();
  const p=service.presence(map,{character:"1"}).presence[0];expect(p.stale).toBe(true);expect(p.observed_at).toBe(now-61_000);
  expect(JSON.stringify(service.presence(map))).not.toContain("secret-token");
  source.characters=()=>[];expect(service.presence(map).presence).toHaveLength(0);
  expect(service.presence(map).presence_coverage.esi_augmentation[0].status).toBe("missing_esi_location_authorization");
  store.patchCredential("1",{enabled:false});expect(service.esiLocations.coverage(map)).toHaveLength(2);
});
it("keeps a labeled 48h baseline and persists current locations across service reconstruction",async()=>{
  await sampleAll();const original=now;now+=49*3600_000;
  const rows=service.presence(map,{current_only:false}).presence;expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({event:"esi.location.baseline",baseline:true,baseline_from:original});
  expect(rows[0].observed_at).toBe(now-48*3600_000);
  await service.stop();service=new NexumService(store,{} as any,{} as any,{},source);
  expect(service.presence(map).presence).toHaveLength(3);expect(service.presence(map).presence[0].stale).toBe(true);
});
it("does not persist an in-flight result after shutdown",async()=>{
  let finish!:(value:any)=>void;source.read=vi.fn(()=>new Promise(r=>finish=r));
  const tick=service.esiLocations.tick();const stopped=service.esiLocations.stop();
  finish({data:{solar_system_id:31000398},metadata:{esiFetchedAt:new Date(now).toISOString(),localCacheExpiresAt:null,cacheStatus:"esi_response"}});
  await Promise.all([tick,stopped]);expect(service.esiLocations.current(map)).toHaveLength(0);
});
