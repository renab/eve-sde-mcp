import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { z } from "zod";
import fs from "fs";
import os from "os";
import path from "path";
vi.mock("../../src/auth/tokens.js",()=>({getTokens:vi.fn(),getCurrentCharacter:vi.fn(),updateTokens:vi.fn()}));
vi.mock("../../src/auth/oauth.js",()=>({refreshAccessToken:vi.fn()}));
import {getTokens} from "../../src/auth/tokens.js";
import {esiGet,esiGetAll,esiCacheIdentity} from "../../src/auth/esi-client.js";
import {getStateDatabase,closeStateDatabase} from "../../src/persistence.js";
import {setBackoff} from "../../src/esi-cache.js";
import {datasetRegistry,logicalDataset,registerDataset,readDataset} from "../../src/esi-datasets.js";
import {subscribeDataset,removeSubscription,listSubscriptions,listDatasetTypes,runWarmPass,startKeepWarm,stopKeepWarm} from "../../src/keep-warm.js";
import {beginForeground,runBackground,WarmDeferred} from "../../src/work-priority.js";
import {registerKeepWarmTools} from "../../src/tools/keep-warm.js";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";

const response=(value:unknown=[],headers:Record<string,string>={"Cache-Control":"max-age=60"})=>new Response(JSON.stringify(value),{headers});
const fetch=vi.fn();
const sub=(dataset="character_assets",params={})=>subscribeDataset({dataset,subject_key:"42",params});
const request=(dataset="character_assets",params={})=>logicalDataset(dataset,"42",params).request;
async function seed(dataset="character_assets",params={}) {
  fetch.mockImplementation(async()=>response());
  await readDataset(request(dataset,params));
  fetch.mockClear();
}
async function expire(){await vi.advanceTimersByTimeAsync(66000);}
describe("keep-warm",()=>{
  beforeEach(()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    const done=beginForeground();done();
    vi.stubGlobal("fetch",fetch);fetch.mockReset();
    vi.mocked(getTokens).mockReset().mockReturnValue({characterId:42,characterName:"Test",accessToken:"secret",refreshToken:"refresh",expiresAt:new Date(Date.now()+86400000),scopes:listDatasetTypes().flatMap(d=>d.required_scopes).join(" ")});
  });
  afterEach(()=>{stopKeepWarm();vi.useRealTimers();vi.unstubAllGlobals();datasetRegistry.delete("test_future");});
  it("adds idempotently, lists/discovers and removes without touching normal cache",async()=>{
    await seed();const a=sub();const b=sub();expect(a.id).toBe(b.id);
    expect(listSubscriptions().subscriptions).toHaveLength(1);
    expect(listDatasetTypes().map(d=>d.dataset)).toEqual(expect.arrayContaining(["character_assets","corporation_assets","wallet_journal","wallet_transactions","industry_jobs"]));
    expect(JSON.stringify(listSubscriptions())).not.toContain("secret");
    expect(removeSubscription(a.id)).toEqual({removed:true,cachePreserved:true});
    expect(listSubscriptions().subscriptions).toEqual([]);
    expect(getStateDatabase().prepare("SELECT count(*) n FROM esi_cache").get()).toEqual({n:1});
    await expire();await runWarmPass();expect(fetch).not.toHaveBeenCalled();
  });
  it("fresh/unexpired and missing-baseline subscriptions cause no calls",async()=>{
    await seed();sub();sub("wallet_transactions");
    await vi.advanceTimersByTimeAsync(10000);await runWarmPass();
    await vi.advanceTimersByTimeAsync(49000);await runWarmPass();
    expect(fetch).not.toHaveBeenCalled();
    expect(listSubscriptions().subscriptions.map(s=>s.cache_status)).toContain("awaiting_cache");
  });
  it.each(["character_assets","corporation_assets","wallet_journal","wallet_transactions","industry_jobs"])("refreshes expired %s through the foreground cache path",async dataset=>{
    const params=dataset==="corporation_assets"?{character_id:42}:{};
    await seed(dataset,params);sub(dataset,params);await expire();await runWarmPass();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listSubscriptions().subscriptions[0].last_refresh_success_at).not.toBeNull();
    await readDataset(request(dataset,params));expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["global","endpoint","cache"])("respects %s cooldown before auth or ESI work",async type=>{
    await seed();sub();await expire();const identity=esiCacheIdentity(request().path,request().options);
    setBackoff(type==="global"?"global":type==="endpoint"?`transport:${identity.url}`:`cache:${identity.key}`,Date.now()+120000);
    await runWarmPass();expect(fetch).not.toHaveBeenCalled();
  });
  it("Retry-After is persisted and does not cause repeated attempts",async()=>{
    await seed();sub();await expire();fetch.mockResolvedValueOnce(new Response(null,{status:429,headers:{"Retry-After":"120"}}));
    await runWarmPass();expect(fetch).toHaveBeenCalledTimes(1);expect(listSubscriptions().subscriptions[0].status).toBe("backoff");
    await vi.advanceTimersByTimeAsync(60000);await runWarmPass();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("foreground activity and its grace period outrank queued warm work",async()=>{
    await seed();sub();await expire();const done=beginForeground();
    await runWarmPass();expect(fetch).not.toHaveBeenCalled();done();
    await runWarmPass();expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5001);await runWarmPass();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rechecks priority immediately before background dispatch",async()=>{
    await seed();await expire();
    const done=beginForeground();
    await expect(runBackground(()=>readDataset(request()))).rejects.toBeInstanceOf(WarmDeferred);
    expect(fetch).not.toHaveBeenCalled();done();
  });
  it("removed queued work cannot dispatch after foreground activity has ended",async()=>{
    await seed();const subscription=sub();await expire();
    removeSubscription(subscription.id);
    await expect(runBackground(()=>readDataset(request()),()=>!!getStateDatabase().prepare("SELECT 1 FROM keep_warm_subscriptions WHERE id=?").get(subscription.id))).rejects.toThrow("removed/disabled");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("foreground use never silently enrolls datasets",async()=>{
    await seed();expect(listSubscriptions().subscriptions).toEqual([]);
    for(const name of ["location","pi_colony","skills","market_prices"]) expect(listDatasetTypes().some(d=>d.dataset===name)).toBe(false);
  });
  it("single-flight shares an already-started warm request with foreground",async()=>{
    await seed();sub();await expire();
    let release!:(r:Response)=>void;fetch.mockImplementationOnce(()=>new Promise<Response>(r=>{release=r;}));
    const warming=runWarmPass();await vi.advanceTimersByTimeAsync(0);
    const done=beginForeground();const foreground=readDataset(request());
    await vi.advanceTimersByTimeAsync(0);expect(fetch).toHaveBeenCalledTimes(1);
    release(response([{id:1}]));await warming;expect(await foreground).toEqual([{id:1}]);done();
  });
  it("warms paginated datasets one upstream page per pass without changing completeness",async()=>{
    fetch.mockResolvedValueOnce(response([1],{"Cache-Control":"max-age=60","x-pages":"3"})).mockResolvedValueOnce(response([2])).mockResolvedValueOnce(response([3]));
    await readDataset(request());fetch.mockClear();sub();await expire();
    fetch.mockImplementation(async(url:string)=>response([Number(new URL(url).searchParams.get("page")??1)],{"Cache-Control":"max-age=600","x-pages":"3"}));
    for(let pass=1;pass<=3;pass++){await runWarmPass();expect(fetch).toHaveBeenCalledTimes(pass);}
    expect(await readDataset(request())).toEqual([1,2,3]);expect(fetch).toHaveBeenCalledTimes(3);
    expect(listSubscriptions().subscriptions[0].status).toBe("refreshed");
  });
  it("startup is quiet, one pass has a single budget, and concurrent passes do not overlap",async()=>{
    for(const dataset of ["character_assets","wallet_transactions","industry_jobs"]){await seed(dataset);sub(dataset);}
    await expire();startKeepWarm();expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29000);expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);expect(fetch).toHaveBeenCalledTimes(1);
    stopKeepWarm();await Promise.all([runWarmPass(),runWarmPass(),runWarmPass()]);expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("fairly advances across many eligible subscriptions without increasing the budget",async()=>{
    for(const dataset of ["character_assets","wallet_journal","wallet_transactions","industry_jobs"]){await seed(dataset);sub(dataset);}
    await expire();
    for(let i=1;i<=4;i++){await runWarmPass();expect(fetch).toHaveBeenCalledTimes(i);await vi.advanceTimersByTimeAsync(1);}
    expect(new Set(fetch.mock.calls.map(call=>call[0])).size).toBe(4);
  });
  it("foregound arrival after the first warm page prevents subsequent warm pages",async()=>{
    fetch.mockResolvedValueOnce(response([1],{"Cache-Control":"max-age=60","x-pages":"2"})).mockResolvedValueOnce(response([2]));
    await esiGetAll(request().path,request().options);fetch.mockClear();sub();await expire();
    let release!:(r:Response)=>void;fetch.mockImplementationOnce(()=>new Promise<Response>(r=>{release=r;}));
    const warming=runWarmPass();await vi.advanceTimersByTimeAsync(0);const done=beginForeground();
    release(response([1],{"Cache-Control":"max-age=600","x-pages":"2"}));await warming;
    expect(fetch).toHaveBeenCalledTimes(1);expect(listSubscriptions().subscriptions[0].status).toBe("deferred");done();
  });
  it("jitter never advances refresh ahead of the expiry boundary",async()=>{
    await seed();sub();await vi.advanceTimersByTimeAsync(60000);await runWarmPass();expect(fetch).not.toHaveBeenCalled();
    expect(listSubscriptions().subscriptions[0].cache_status).toBe("waiting_jitter");
    await vi.advanceTimersByTimeAsync(5001);await runWarmPass();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("missing auth/scope blocks visibly and requires explicit re-enable",async()=>{
    await seed();sub();await expire();vi.mocked(getTokens).mockReturnValue(null);
    await runWarmPass();expect(listSubscriptions().subscriptions[0].status).toBe("blocked_auth");
    vi.mocked(getTokens).mockClear();await runWarmPass();await runWarmPass();expect(getTokens).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    vi.mocked(getTokens).mockReturnValue({characterId:42,scopes:""} as any);sub();await runWarmPass();expect(listSubscriptions().subscriptions[0].status).toBe("blocked_auth");
  });
  it("403 and unexpected failures block rather than looping; 5xx uses existing cooldown",async()=>{
    await seed();sub();await expire();fetch.mockResolvedValueOnce(new Response("forbidden",{status:403}));
    await runWarmPass();await runWarmPass();expect(fetch).toHaveBeenCalledTimes(1);expect(listSubscriptions().subscriptions[0].status).toBe("blocked_auth");
    sub();await vi.advanceTimersByTimeAsync(31000);await seed();await expire();fetch.mockResolvedValueOnce(new Response(null,{status:503}));
    await runWarmPass();expect(fetch).toHaveBeenCalledTimes(1);await runWarmPass();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("disabled and no-freshness subscriptions never warm",async()=>{
    await seed();subscribeDataset({dataset:"character_assets",subject_key:"42",enabled:false});await expire();await runWarmPass();expect(fetch).not.toHaveBeenCalled();
    sub();fetch.mockResolvedValueOnce(response([],{"Cache-Control":"no-cache"}));await readDataset(request());fetch.mockClear();await runWarmPass();expect(fetch).not.toHaveBeenCalled();
    expect(listSubscriptions().subscriptions[0].cache_status).toBe("awaiting_freshness");
  });
  it("new registered dataset works without changing scheduler/storage; unsupported types fail",async()=>{
    expect(()=>sub("arbitrary_url")).toThrow("not yet registered");
    expect(()=>sub("character_assets",{url:"https://example.com"})).toThrow();
    registerDataset({name:"test_future",description:"Test adapter",subject:"test",params:z.object({}).strict(),requiredScopes:[],build:()=>({path:"/future/",options:{public:true},pagination:"single"})});
    await seed("test_future");sub("test_future");await expire();await runWarmPass();expect(fetch).toHaveBeenCalledTimes(1);
    expect(listDatasetTypes().some(d=>d.dataset==="test_future")).toBe(true);
    expect(listSubscriptions().subscriptions).toHaveLength(1);
  });
  it("canonicalizes params, exposes schemas, and preserves current job/transaction semantics",()=>{
    expect(sub("industry_jobs").id).toBe(sub("industry_jobs",{include_completed:false}).id);
    expect(request("industry_jobs",{include_completed:true}).path).toContain("?include_completed=true");
    expect(request("wallet_transactions").pagination).toBe("single");expect(request("wallet_journal").pagination).toBe("all");
    expect(listDatasetTypes().find(d=>d.dataset==="corporation_assets")!.params_schema).toHaveProperty("required",["character_id"]);
  });
  it("MCP add/remove/list operations work at runtime",async()=>{
    const handlers:Record<string,any>={};registerKeepWarmTools({tool:(name:string,_d:string,_s:unknown,handler:any)=>{handlers[name]=handler;}} as unknown as McpServer);
    const unpack=(r:any)=>JSON.parse(r.content[0].text);
    const created=unpack(await handlers.keep_warm_dataset({dataset:"character_assets",subject_key:"42",params:{},enabled:true}));
    expect(unpack(await handlers.list_keep_warm_datasets({limit:100,offset:0})).subscriptions).toHaveLength(1);
    expect(unpack(await handlers.list_keep_warm_dataset_types({})).datasets.length).toBeGreaterThanOrEqual(5);
    expect(unpack(await handlers.remove_keep_warm_dataset({id:created.id})).removed).toBe(true);
  });
  it("subscriptions persist across database restart without auto-enrollment or startup traffic",async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"galaxy-warm-test-"));const original=process.env.GALAXY_STATE_DB;
    try {
      closeStateDatabase();process.env.GALAXY_STATE_DB=path.join(dir,"state.db");
      expect(listSubscriptions().subscriptions).toEqual([]);const created=sub();closeStateDatabase();
      expect(listSubscriptions().subscriptions[0].id).toBe(created.id);startKeepWarm();expect(fetch).not.toHaveBeenCalled();
    } finally {stopKeepWarm();closeStateDatabase();process.env.GALAXY_STATE_DB=original;fs.rmSync(dir,{recursive:true});}
  });
});
