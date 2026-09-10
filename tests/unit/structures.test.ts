import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
vi.mock("../../src/auth/tokens.js",()=>({getTokens:vi.fn(),getCurrentCharacter:vi.fn()}));
vi.mock("../../src/auth/esi-client.js",()=>({esiGetWithMetadata:vi.fn(),esiGet:vi.fn(),esiGetAll:vi.fn(),esiPost:vi.fn(),getActiveCharacter:vi.fn()}));
vi.mock("../../src/database.js",()=>({getDatabase:()=>({prepare:(sql:string)=>({get:()=>sql.includes("solarSystemName")?{solarSystemName:"J154212"}:{typeName:"Fortizar"}})})}));
import {getTokens,getCurrentCharacter} from "../../src/auth/tokens.js";
import {esiGetWithMetadata,esiGet,esiGetAll,getActiveCharacter} from "../../src/auth/esi-client.js";
import {resolveStructure,enrichStructures,structureIdSchema} from "../../src/structures.js";
import {getStateDatabase} from "../../src/persistence.js";
import {parseEsiJson} from "../../src/esi-json.js";
import {createMcpServer} from "../../src/server.js";

const id=1039342434314;
const data={name:"J154212 - Cervantes Freeport Annex",solar_system_id:31000398,type_id:35833,owner_id:98570449,position:{x:1,y:2,z:3}};
const character={characterId:42,characterName:"Test",scopes:"esi-universe.read_structures.v1 esi-location.read_location.v1"};
const snapshot=()=>({data:{...data},metadata:{esiFetchedAt:new Date().toISOString(),localCacheExpiresAt:new Date(Date.now()+3600000).toISOString(),esiCacheControl:"max-age=3600"}} as any);
describe("structure metadata resolver",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    vi.mocked(getTokens).mockReturnValue(character as any);vi.mocked(getCurrentCharacter).mockReturnValue(character as any);
    vi.mocked(getActiveCharacter).mockResolvedValue(character as any);vi.mocked(esiGetWithMetadata).mockImplementation(async()=>snapshot());
  });
  afterEach(()=>vi.useRealTimers());
  it("fetches a miss, caches it, and enriches names locally",async()=>{
    const first=await resolveStructure(id,42);const second=await resolveStructure(id,42);
    expect(first).toMatchObject({...data,structure_id:id,type_name:"Fortizar",solar_system_name:"J154212",cache:{stale:false,auth_character_id:42}});
    expect(second).toEqual(first);expect(esiGetWithMetadata).toHaveBeenCalledTimes(1);
    expect(esiGetWithMetadata).toHaveBeenCalledWith(`/universe/structures/${id}/`,{characterId:42,allowStale:false});
  });
  it("refreshes mutable names at expiry",async()=>{
    await resolveStructure(id,42);vi.advanceTimersByTime(3600001);
    vi.mocked(esiGetWithMetadata).mockResolvedValueOnce({...snapshot(),data:{...data,name:"Renamed"}});
    expect((await resolveStructure(id,42)).name).toBe("Renamed");expect(esiGetWithMetadata).toHaveBeenCalledTimes(2);
  });
  it("keeps a last-known success after access denial and records the error",async()=>{
    await resolveStructure(id,42);vi.advanceTimersByTime(3600001);
    vi.mocked(esiGetWithMetadata).mockRejectedValueOnce(new Error("ESI failed (403)"));
    const stale=await resolveStructure(id,42);expect(stale.name).toBe(data.name);expect(stale.cache.stale).toBe(true);expect(stale.cache.last_error).toContain("403");
    expect((await resolveStructure(id,42)).cache.stale).toBe(true);expect(esiGetWithMetadata).toHaveBeenCalledTimes(2);
    expect(await resolveStructure(id,42,false)).toBeNull();
  });
  it("negatively caches access failures without removing raw IDs",async()=>{
    vi.mocked(esiGetWithMetadata).mockRejectedValue(new Error("ESI failed (403)"));
    const input={structure_id:id,solar_system_id:31000398};
    expect(await enrichStructures(input,42)).toEqual(input);expect(await enrichStructures(input,42)).toEqual(input);
    expect(esiGetWithMetadata).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15*60000+1);await enrichStructures(input,42);expect(esiGetWithMetadata).toHaveBeenCalledTimes(2);
  });
  it("preserves exact decimal strings and rejects already-rounded numbers",async()=>{
    const large="9007199254740993";
    expect((await resolveStructure(large,42)).structure_id).toBe(large);
    expect(getStateDatabase().prepare("SELECT structure_id FROM structure_resolutions").get()).toEqual({structure_id:large});
    expect(()=>structureIdSchema.parse(Number(large))).toThrow();
    expect(parseEsiJson('{"structure_id":9007199254740993,"safe":1039342434314,"text":"9007199254740993"}')).toEqual({structure_id:large,safe:id,text:large});
  });
  it("separates auth provenance and coalesces concurrent lookups",async()=>{
    await Promise.all(Array.from({length:10},()=>resolveStructure(id,42)));expect(esiGetWithMetadata).toHaveBeenCalledTimes(1);
    vi.mocked(getTokens).mockReturnValue({...character,characterId:43} as any);expect((await resolveStructure(id,43)).cache.auth_character_id).toBe(43);expect(esiGetWithMetadata).toHaveBeenCalledTimes(2);
  });
  it("uses four-hour fallback only without upstream freshness and honors no-store",async()=>{
    vi.mocked(esiGetWithMetadata).mockResolvedValue({...snapshot(),metadata:{esiFetchedAt:new Date().toISOString()}});
    expect(Date.parse((await resolveStructure(id,42)).cache.expires_at)-Date.now()).toBe(4*3600000);
    vi.mocked(esiGetWithMetadata).mockResolvedValue({...snapshot(),metadata:{esiFetchedAt:new Date().toISOString(),esiCacheControl:"no-store"}});
    await resolveStructure(id+1,42);expect(getStateDatabase().prepare("SELECT count(*) n FROM structure_resolutions").get()).toEqual({n:1});
  });
  it("enriches all location key forms, deduplicates and leaves containers/NPCs alone",async()=>{
    const rows=await enrichStructures([{locationId:id},{facilityId:id},{blueprint_location_id:id},{station_id:id},{start_location_id:id},{location_id:id,location_type:"item"},{station_id:60003760},{solar_system_id:31000398}],42) as any[];
    expect(rows[0].location_structure.name).toBe(data.name);expect(rows[1].facility_structure.name).toBe(data.name);expect(rows[2].blueprint_location_structure.name).toBe(data.name);
    expect(rows[5]).toEqual({location_id:id,location_type:"item"});expect(rows[6]).toEqual({station_id:60003760});expect(esiGetWithMetadata).toHaveBeenCalledTimes(1);
  });
  it("caps broad-response lookups with visible warnings",async()=>{
    const rows=await enrichStructures(Array.from({length:11},(_,i)=>({structure_id:id+i})),42) as any[];
    expect(esiGetWithMetadata).toHaveBeenCalledTimes(10);expect(rows[10].structure_id_resolution_warning).toContain("budget");
  });
  it("missing scope never calls ESI",async()=>{
    vi.mocked(getTokens).mockReturnValue({...character,scopes:""} as any);
    expect(await resolveStructure(id,42)).toBeNull();expect(esiGetWithMetadata).not.toHaveBeenCalled();
  });
  it("location and existing get_structure use the same resolver in actual server registration",async()=>{
    const server=createMcpServer();const tools=(server as any)._registeredTools;
    vi.mocked(esiGet).mockResolvedValue({solar_system_id:31000398,structure_id:id});
    const location=JSON.parse((await tools.get_character_location.handler({character_id:42})).content[0].text);
    expect(location.data).toMatchObject({structure_id:id,structure:{name:data.name,type_id:35833,owner_id:98570449}});
    const direct=JSON.parse((await tools.get_structure.handler({character_id:42,structure_id:id})).content[0].text);
    expect(direct).toMatchObject(data);expect(esiGetWithMetadata).toHaveBeenCalledTimes(1);await server.close();
  });
  it("location tool still succeeds when structure access is denied",async()=>{
    const server=createMcpServer();vi.mocked(esiGet).mockResolvedValue({solar_system_id:31000398,structure_id:id});
    vi.mocked(esiGetWithMetadata).mockRejectedValue(new Error("403"));
    const result=await (server as any)._registeredTools.get_character_location.handler({character_id:42});
    expect(result.isError).not.toBe(true);expect(JSON.parse(result.content[0].text).data).toEqual({solar_system_id:31000398,solar_system_name:"J154212",structure_id:id});await server.close();
  });
  it("asset response filtering and enrichment retain exact large location strings",async()=>{
    const large="9007199254740993";const server=createMcpServer();
    vi.mocked(esiGetAll).mockResolvedValue([{item_id:1,type_id:35833,quantity:1,location_id:large,location_type:"other",location_flag:"Hangar",is_singleton:true}]);
    const result=JSON.parse((await (server as any)._registeredTools.get_character_assets.handler({character_id:42,location_id:large})).content[0].text);
    expect(result.assets).toHaveLength(1);expect(result.assets[0]).toMatchObject({locationId:large,location_structure:{structure_id:large,name:data.name}});await server.close();
  });
  it.each([{solar_system_id:31000398},{solar_system_id:31000398,station_id:60003760}])("space and NPC location preserve existing behavior: %j",async value=>{
    const server=createMcpServer();vi.mocked(esiGet).mockResolvedValue(value);
    const result=JSON.parse((await (server as any)._registeredTools.get_character_location.handler({character_id:42})).content[0].text);
    expect(result.data).toMatchObject(value);expect(esiGetWithMetadata).not.toHaveBeenCalled();await server.close();
  });
});
