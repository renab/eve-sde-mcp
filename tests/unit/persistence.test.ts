import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateDatabase, openStateDatabase, closeStateDatabase } from "../../src/persistence.js";
import fs from "fs";
import os from "os";
import path from "path";
import { Ledger } from "../../src/ledger.js";
import { GENERATED_START, GENERATED_END, renderRecap, replaceGenerated } from "../../src/recaps.js";
import { cachedEsiGet, disciplinedFetch, EsiUnavailable, setBackoff } from "../../src/esi-cache.js";

const json = (data: unknown, headers: Record<string,string> = {}) => new Response(JSON.stringify(data),{headers});
describe("SQLite ESI safety", () => {
  beforeEach(()=>{ vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T12:00:00Z")); });
  afterEach(()=>{ vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("makes zero calls on fresh hits including force refresh; upstream expiry permits refresh",async()=>{
    const fetcher = vi.fn().mockResolvedValue(json({x:1},{"Cache-Control":"max-age=600"}));
    await cachedEsiGet("a","/test",fetcher);
    await cachedEsiGet("a","/test",fetcher,{forceRefresh:true});
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600000);
    fetcher.mockResolvedValueOnce(json({x:2}));
    expect((await cachedEsiGet<any>("a","/test",fetcher)).data.x).toBe(2);
  });
  it("coalesces concurrent refreshes and clones data",async()=>{
    const fetcher=vi.fn(async()=>json({x:1},{"Cache-Control":"max-age=1"}));
    const results=await Promise.all(Array.from({length:20},()=>cachedEsiGet<any>("same","/test",fetcher)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    results[0].data.x=9; expect(results[1].data.x).toBe(1);
    vi.advanceTimersByTime(1001);
    await Promise.all(Array.from({length:20},()=>cachedEsiGet("same","/test",fetcher)));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("uses conditional ETags and merges 304 metadata without resetting payload",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(json({pins:[1]},{"Cache-Control":"max-age=1",ETag:'"a"'}));
    await cachedEsiGet("etag","/characters/1/planets/2/",fetcher);
    vi.advanceTimersByTime(1001);
    fetcher.mockResolvedValueOnce(new Response(null,{status:304,headers:{"Cache-Control":"max-age=600"}}));
    const result=await cachedEsiGet("etag","/characters/1/planets/2/",fetcher);
    expect(fetcher).toHaveBeenLastCalledWith({"If-None-Match":'"a"'});
    expect(result.data).toEqual({pins:[1]});
    expect(result.metadata.cacheStatus).toBe("revalidated");
    expect(result.metadata.semanticStalenessNote).toContain("Polling harder");
  });
  it("honors Expires and Age without a local polling TTL",async()=>{
    const fetcher=vi.fn(async()=>json({}, {Date:new Date().toUTCString(),Expires:new Date(Date.now()+600000).toUTCString(),Age:"300"}));
    const result=await cachedEsiGet("expiry","/test",fetcher);
    expect(Date.parse(result.metadata.localCacheExpiresAt!)-Date.now()).toBe(300000);
  });
  it.each(["no-store, max-age=60","no-cache, max-age=60"])("honors %s",async control=>{
    const fetcher=vi.fn(async()=>json({}, {"Cache-Control":control}));
    await cachedEsiGet("control","/test",fetcher);
    await cachedEsiGet("control","/test",fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    if(control.startsWith("no-store")) expect(getStateDatabase().prepare("SELECT count(*) n FROM esi_cache").get()).toEqual({n:0});
  });
  it("marks stale on failure, prevents repeated refreshes, and refuses stale for data-only consumers",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(json({x:1},{"Cache-Control":"max-age=1"}));
    await cachedEsiGet("stale","/test",fetcher);
    vi.advanceTimersByTime(1001);
    fetcher.mockRejectedValueOnce(new EsiUnavailable("down",Date.now()+60000));
    const stale=await cachedEsiGet("stale","/test",fetcher,{allowStale:true});
    expect(stale.metadata).toMatchObject({cacheStatus:"stale_on_error",staleReason:"down"});
    await cachedEsiGet("stale","/test",fetcher,{allowStale:true,forceRefresh:true});
    await expect(cachedEsiGet("stale","/test",fetcher)).rejects.toThrow("cooling down");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never serves stale on auth errors or must-revalidate",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(json({}, {"Cache-Control":"max-age=1, must-revalidate"}));
    await cachedEsiGet("strict","/test",fetcher); vi.advanceTimersByTime(1001);
    fetcher.mockRejectedValueOnce(new EsiUnavailable("down",Date.now()+1));
    await expect(cachedEsiGet("strict","/test",fetcher,{allowStale:true})).rejects.toThrow("down");
    vi.advanceTimersByTime(2); fetcher.mockResolvedValueOnce(new Response("denied",{status:403}));
    await expect(cachedEsiGet("strict","/test",fetcher,{allowStale:true})).rejects.toThrow("403");
  });
  it.each([420,429,503])("honors Retry-After on %s and avoids a retry storm",async status=>{
    const fetch=vi.fn().mockResolvedValue(new Response(null,{status,headers:{"Retry-After":"120"}})); vi.stubGlobal("fetch",fetch);
    await expect(disciplinedFetch("https://example.test",{})).rejects.toThrow(EsiUnavailable);
    await expect(disciplinedFetch("https://example.test",{})).rejects.toThrow("backoff");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(122000); fetch.mockResolvedValueOnce(json({}));
    await disciplinedFetch("https://example.test",{}); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("honors HTTP-date Retry-After and low error-limit headers globally",async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(json({}, {"x-esi-error-limit-remain":"5","x-esi-error-limit-reset":"60"})); vi.stubGlobal("fetch",fetch);
    await disciplinedFetch("https://example.test/a",{});
    await expect(disciplinedFetch("https://example.test/b",{})).rejects.toThrow("rate limited");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61000);
    fetch.mockResolvedValueOnce(new Response(null,{status:429,headers:{"Retry-After":new Date(Date.now()+120000).toUTCString()}}));
    await expect(disciplinedFetch("https://example.test/b",{})).rejects.toThrow(EsiUnavailable);
    vi.advanceTimersByTime(61000);
    await expect(disciplinedFetch("https://example.test/b",{})).rejects.toThrow("backoff");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("retries GET 5xx with bounded exponential jitter; never retries a write",async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:502})).mockResolvedValueOnce(json({})); vi.stubGlobal("fetch",fetch);
    const promise=disciplinedFetch("https://example.test/retry",{});
    await vi.advanceTimersByTimeAsync(2500); await promise; expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValueOnce(new Response(null,{status:502}));
    await expect(disciplinedFetch("https://example.test/write",{method:"POST"})).rejects.toThrow(EsiUnavailable);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("fresh cache hits work during an ESI circuit-breaker pause",async()=>{
    const fetcher=vi.fn(async()=>json({}, {"Cache-Control":"max-age=600"}));
    await cachedEsiGet("hit","/test",fetcher); setBackoff("global",Date.now()+120000);
    await cachedEsiGet("hit","/test",fetcher); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("persists fresh entries, cooldowns and records across database reopen",async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),"galaxy-persistence-test-"));
    const original=process.env.GALAXY_STATE_DB;
    try {
      closeStateDatabase(); process.env.GALAXY_STATE_DB=path.join(directory,"state.db");
      const fetcher=vi.fn(async()=>json({x:1},{"Cache-Control":"max-age=600"}));
      await cachedEsiGet("disk","/test",fetcher);
      new Ledger(getStateDatabase()).store({namespace:"test",kind:"durable",key:"one",payload:{x:1}});
      setBackoff("global",Date.now()+60000); closeStateDatabase();
      expect((await cachedEsiGet("disk","/test",fetcher)).metadata.cacheStatus).toBe("local_hit");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new Ledger(getStateDatabase()).get({namespace:"test",kind:"durable",key:"one"})?.payload).toEqual({x:1});
      await expect(disciplinedFetch("https://example.test",{})).rejects.toThrow("backoff");
    } finally {
      closeStateDatabase(); process.env.GALAXY_STATE_DB=original;
      fs.rmSync(directory,{recursive:true});
    }
  });
});

describe("schema-light ledger and projections",()=>{
  const base={namespace:"wormlife",kind:"gas_run",key:"run",observed_at:"2026-09-09T19:30:00-04:00",source_type:"user_report",source_ref:"user:report",tags:["C72"],payload:{site:"Minor Perimeter",harvest:{C72:4000},note:"Renab scanned while McGreggor and Minner huffed"}};
  let ledger: Ledger;
  beforeEach(()=>{ledger=new Ledger(getStateDatabase());});
  it("accepts new kinds/fields with no schema changes and exact scoped lookup",()=>{
    const before=ledger.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    ledger.store(base); ledger.store({...base,key:"new",payload:{hostile_contacts:1,cloud_start:{C32:20000}}});
    ledger.store({...base,kind:"brand_new",payload:{anything:[1,"two"]}});
    expect(ledger.db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(ledger.get({namespace:"wormlife",kind:"gas_run",key:"run"})?.payload).toEqual(base.payload);
    expect(ledger.get({namespace:"other",kind:"gas_run",key:"run"})).toBeNull();
  });
  it("preserves corrections and forbids branching/accidental overwrites",()=>{
    const a=ledger.store({...base,status:"interim"});
    const b=ledger.store({...base,status:"final",payload:{harvest:{C72:4380}}},a.id);
    expect(ledger.get({namespace:"wormlife",kind:"gas_run",key:"run"})?.id).toBe(b.id);
    expect(ledger.history({namespace:"wormlife",id:a.id}).map(r=>r!.id)).toEqual([a.id,b.id]);
    expect(ledger.search({namespace:"wormlife"}).total).toBe(1);
    expect(ledger.search({namespace:"wormlife",current_only:false}).total).toBe(2);
    expect(()=>ledger.store(base)).toThrow("supersede_record");
    expect(()=>ledger.store(base,a.id)).toThrow("already been superseded");
    expect(()=>ledger.store({...base,namespace:"other"},b.id)).toThrow("preserve namespace");
  });
  it("supports tags/date/JSON filtering and lexical FTS",()=>{
    ledger.store(base); ledger.store({...base,key:"other",tags:["C70"],payload:{harvest:{C72:1}}});
    const result=ledger.search({namespace:"wormlife",kind:"gas_run",tags:["C72"],observed_from:"2026-09-09T00:00:00Z",observed_to:"2026-09-10T00:00:00Z",filters:[{path:"$.payload.harvest.C72",op:">=",value:4000}]});
    expect(result.total).toBe(1);
    expect(ledger.search({namespace:"wormlife",text:"Renab scanned while McGreggor and Minner huffed"}).total).toBe(1);
    for (const filter of [{path:"$.payload.site",op:"contains",value:"Perimeter"},{path:"$.payload.site",op:"in",value:["Minor Perimeter"]},{path:"$.payload.harvest.C72",op:"exists"}]) expect(ledger.search({namespace:"wormlife",key:"run",filters:[filter]}).total).toBe(1);
    expect(()=>ledger.search({namespace:"wormlife",filters:[{path:"$.payload.a); DROP TABLE records;--",op:"=",value:1}]})).toThrow();
  });
  it("creates and queries namespace-scoped relationships",()=>{
    ledger.link({namespace:"wormlife",from_key:"J154212",relation:"HS_STATIC",to_key:"Erstur",payload:{source_ref:"user:today"}});
    expect(ledger.relationships({namespace:"wormlife",from_key:"J154212"}).relationships[0].to_key).toBe("Erstur");
    expect(ledger.relationships({namespace:"other"}).relationships).toEqual([]);
  });
  it("describes types/presence and suggests promotion without migration",()=>{
    for(let n=0;n<30;n++) ledger.store({...base,key:String(n),payload:{site:"Minor",...(n<15?{elapsed_minutes:12}:{})}});
    for(let n=0;n<10;n++) ledger.search({namespace:"wormlife",kind:"gas_run"});
    const result=ledger.describe("wormlife","gas_run");
    expect(result.recordCount).toBe(30); expect(result.promotion.candidate).toBe(true);
    expect(result.fields).toContainEqual({path:"payload.elapsed_minutes",types:["number"],presence:15,presencePercent:50});
    expect(result.promotion.automaticMigration).toBe(false);
  });
  it("renders current run, daily and trial summaries without overwriting human notes",()=>{
    const a=ledger.store(base); const b=ledger.store({...base,payload:{harvest:{C72:4380}}},a.id);
    ledger.store({...base,kind:"expense",key:"fuel",payload:{expense_isk:500}});
    const input={namespace:"wormlife",vaultId:"wormlife-trial",filepath:"Recaps/day.md",existing_markdown:"# My title\r\n\r\nHuman note: KEEP THIS\r\n"};
    const run=renderRecap(ledger,{...input,mode:"run",id:a.id});
    expect(run.recordIds).toEqual([b.id]); expect(run.markdown).toContain("4,380"); expect(run.markdown).not.toContain("4,000");
    const daily=renderRecap(ledger,{...input,mode:"daily",date:"2026-09-09",timezone:"America/New_York"});
    expect(daily.recordIds).toHaveLength(2); expect(daily.markdown).toContain("expense\\_isk: 500");
    const repeat=renderRecap(ledger,{...input,existing_markdown:daily.markdown,mode:"daily",date:"2026-09-09",timezone:"America/New_York"});
    expect(repeat.markdown).toBe(daily.markdown); expect(repeat.markdown.startsWith(input.existing_markdown)).toBe(true);
    expect(renderRecap(ledger,{...input,mode:"trial"}).recordIds).toHaveLength(2);
  });
  it("preserves suffix and prefix bytes; rejects malformed markers",()=>{
    const original=`Human\r\n${GENERATED_START}\nold\n${GENERATED_END}\r\nJosh's annotations`;
    const generated=`${GENERATED_START}\nnew\n${GENERATED_END}`;
    expect(replaceGenerated(original,generated)).toBe(`Human\r\n${generated}\r\nJosh's annotations`);
    expect(()=>replaceGenerated(GENERATED_START,generated)).toThrow("Malformed");
  });
  it("includes one-hop related run records and keeps estimates separate",()=>{
    const run=ledger.store(base);
    const loot=ledger.store({...base,kind:"salvage_run",key:"loot",source_type:"esi_wallet",payload:{income_isk:100}});
    ledger.store({...base,kind:"market_snapshot",key:"estimate",source_type:"current_market_estimate",payload:{estimated_value_isk:300}});
    ledger.link({namespace:"wormlife",from_key:run.id,relation:"RELATED_LOOT",to_key:loot.id});
    const recap=renderRecap(ledger,{namespace:"wormlife",mode:"run",id:run.id,vaultId:"wormlife-trial",filepath:"run.md"});
    expect(recap.recordIds).toEqual([run.id,loot.id]);
    expect(recap.markdown).toContain("esi\\_wallet");
    expect(recap.markdown).not.toContain("300");
  });
  it("keeps undated facts out of daily recaps and uses the selected timezone",()=>{
    ledger.store({...base,observed_at:"2026-09-10T02:00:00Z"});
    ledger.store({namespace:"wormlife",kind:"unknown",payload:{}});
    const args={namespace:"wormlife",mode:"daily" as const,date:"2026-09-09",vaultId:"wormlife-trial",filepath:"daily.md"};
    expect(renderRecap(ledger,{...args,timezone:"America/New_York"}).recordIds).toHaveLength(1);
    expect(renderRecap(ledger,{...args,timezone:"UTC"}).recordIds).toHaveLength(0);
  });
  it("does not permit payload text to inject generated markers",()=>{
    const r=ledger.store({...base,payload:{note:GENERATED_START}});
    const projection=renderRecap(ledger,{namespace:"wormlife",mode:"run",id:r.id,vaultId:"wormlife-trial",filepath:"run.md"});
    expect(projection.markdown.split(GENERATED_START)).toHaveLength(2);
  });
  it("has SQLite JSON and FTS5 available",()=>{
    const db=openStateDatabase(":memory:"); expect(db.prepare("SELECT json_extract('{\"x\":1}','$.x') x").get()).toEqual({x:1}); db.close();
  });
});
