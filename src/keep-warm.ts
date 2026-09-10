import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getStateDatabase } from "./persistence.js";
import { getTokens } from "./auth/tokens.js";
import { esiCacheIdentity, esiPagePath } from "./auth/esi-client.js";
import { backoffUntil, inspectEsiCache, EsiUnavailable } from "./esi-cache.js";
import { datasetRegistry, logicalDataset, readDataset, type DatasetRequest } from "./esi-datasets.js";
import { isIdle, runBackground, WarmDeferred } from "./work-priority.js";

export const subscriptionShape = {
  dataset:z.string().min(1).max(100),subject_key:z.string().trim().min(1).max(200),
  params:z.record(z.string(),z.unknown()).default({}),enabled:z.boolean().default(true),
};
type Subscription = {id:string;dataset:string;subject_key:string;params_json:string;enabled:number;created_at:string;
  last_considered_at:string|null;last_refresh_attempt_at:string|null;last_refresh_success_at:string|null;
  last_error:string|null;status:string;jitter_ms:number};
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function subscribeDataset(input: unknown) {
  const s=z.object(subscriptionShape).parse(input);
  const subject=/^\d+$/.test(s.subject_key) ? String(Number(s.subject_key)) : s.subject_key;
  const logical=logicalDataset(s.dataset,subject,s.params);
  const params=JSON.stringify(canonical(logical.params));
  getStateDatabase().prepare(`INSERT INTO keep_warm_subscriptions (id,dataset,subject_key,params_json,enabled,created_at,jitter_ms)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(dataset,subject_key,params_json) DO UPDATE SET enabled=excluded.enabled,status='subscribed',last_error=NULL`)
    .run(randomUUID(),s.dataset,subject,params,Number(s.enabled),new Date().toISOString(),1000+Math.floor(Math.random()*4000));
  const row=getStateDatabase().prepare("SELECT * FROM keep_warm_subscriptions WHERE dataset=? AND subject_key=? AND params_json=?").get(s.dataset,subject,params) as Subscription;
  return view(row);
}
export function removeSubscription(id:string) {
  return {removed:getStateDatabase().prepare("DELETE FROM keep_warm_subscriptions WHERE id=?").run(id).changes>0,cachePreserved:true};
}
function inspect(row:Subscription): {status:string;eligibleAt:number|null;expiresAt?:number;request?:DatasetRequest;error?:string} {
  if (!row.enabled) return {status:"disabled",eligibleAt:null};
  if (row.status.startsWith("blocked")) return {status:row.status,eligibleAt:null,error:row.last_error ?? undefined};
  let logical:ReturnType<typeof logicalDataset>;
  try { logical=logicalDataset(row.dataset,row.subject_key,JSON.parse(row.params_json)); }
  catch(error) {return {status:"blocked_definition",eligibleAt:null,error:String(error)};}
  const request=logical.request;
  if (!request.options.public) {
    let character:ReturnType<typeof getTokens>;
    try {character=request.options.characterId ? getTokens(request.options.characterId) : null;}
    catch {return {status:"blocked_auth",eligibleAt:null,error:"Stored authentication could not be read. Repair auth, then explicitly re-enable this subscription."};}
    if (!character || logical.definition.requiredScopes.some(scope=>!character.scopes.split(" ").includes(scope))) {
      return {status:"blocked_auth",eligibleAt:null,error:"Missing authenticated character or required scopes. Reauthenticate, then re-enable via keep_warm_dataset."};
    }
  }
  const state=(page:number)=>{const identity=esiCacheIdentity(esiPagePath(request.path,page),request.options);return inspectEsiCache(identity.key,identity.url);};
  const first=state(1);
  if (!first.exists) return {status:"awaiting_cache",eligibleAt:null,request};
  const pages=request.pagination === "all" ? first.pages : 1;
  let earliest=Infinity;
  let expiry=Infinity;
  for(let page=1;page<=pages;page++) {
    const cache=page === 1 ? first : state(page);
    if(cache.inflight) return {status:"in_flight",eligibleAt:null,request};
    if(cache.exists && !cache.hasFreshness) return {status:"awaiting_freshness",eligibleAt:null,request};
    const eligibleAt=Math.max(cache.expiresAt ?? first.expiresAt!,cache.retryAt)+row.jitter_ms;
    expiry=Math.min(expiry,cache.expiresAt ?? first.expiresAt!);
    earliest=Math.min(earliest,eligibleAt);
    // Reads walk pages in order: never start a logical refresh if an earlier page
    // needs refresh but is cooling down. Later fresh pages cannot bypass that gate.
    if((cache.expiresAt ?? 0)<=Date.now() && cache.retryAt>Date.now()) return {status:"backoff",eligibleAt:cache.retryAt+row.jitter_ms,expiresAt:expiry,request};
  }
  return {status:earliest<=Date.now()?"eligible":expiry<=Date.now()?"waiting_jitter":"fresh",eligibleAt:earliest,expiresAt:expiry,request};
}
function view(row:Subscription) {
  const state=inspect(row);
  return {...row,params_json:undefined,params:JSON.parse(row.params_json),enabled:!!row.enabled,
    cache_status:state.status,next_refresh_eligible_at:state.eligibleAt === null?null:new Date(state.eligibleAt).toISOString(),
    expires_at:state.expiresAt === undefined?null:new Date(state.expiresAt).toISOString(),
    last_error:state.error ?? row.last_error};
}
export function listSubscriptions(limit=100,offset=0) {
  const rows=getStateDatabase().prepare("SELECT * FROM keep_warm_subscriptions ORDER BY created_at,id LIMIT ? OFFSET ?").all(limit+1,offset) as Subscription[];
  return {subscriptions:rows.slice(0,limit).map(view),nextOffset:rows.length>limit?offset+limit:null};
}
export function listDatasetTypes() {
  return [...datasetRegistry.values()].map(d=>({dataset:d.name,description:d.description,subject:d.subject,params_schema:z.toJSONSchema(d.params,{io:"input"}),required_scopes:d.requiredScopes}));
}
let running=false;
let timer:ReturnType<typeof setInterval>|undefined;
let generation=0;
export async function runWarmPass():Promise<void> {
  if(running || !isIdle() || backoffUntil("global")>Date.now()) return;
  running=true;
  try {
    const db=getStateDatabase();
    const rows=db.prepare(`SELECT * FROM keep_warm_subscriptions WHERE enabled=1 AND status NOT LIKE 'blocked%'
      ORDER BY coalesce(last_considered_at,''),coalesce(last_refresh_attempt_at,''),created_at,id LIMIT 100`).all() as Subscription[];
    for(const row of rows) {
      if(!isIdle()) return;
      const state=inspect(row);
      db.prepare("UPDATE keep_warm_subscriptions SET last_considered_at=?,status=?,last_error=coalesce(?,last_error) WHERE id=?")
        .run(new Date().toISOString(),state.status,state.error ?? null,row.id);
      if(state.status!=="eligible" || !state.request) continue;
      // No await occurs between final foreground/enrollment check and dispatch.
      if(!isIdle() || !db.prepare("SELECT 1 FROM keep_warm_subscriptions WHERE id=? AND enabled=1").get(row.id)) return;
      db.prepare("UPDATE keep_warm_subscriptions SET last_refresh_attempt_at=?,status='refreshing' WHERE id=?").run(new Date().toISOString(),row.id);
      try {
        const startedGeneration=generation;
        await runBackground(()=>readDataset(state.request!),()=>startedGeneration===generation && !!db.prepare("SELECT 1 FROM keep_warm_subscriptions WHERE id=? AND enabled=1").get(row.id));
        db.prepare("UPDATE keep_warm_subscriptions SET last_refresh_success_at=?,status='refreshed',last_error=NULL WHERE id=?").run(new Date().toISOString(),row.id);
      } catch(error) {
        const message=error instanceof Error?error.message:String(error);
        const status=error instanceof WarmDeferred?"deferred":error instanceof EsiUnavailable?"backoff":/token|auth|scope|\(401\)|\(403\)/i.test(message)?"blocked_auth":"blocked_error";
        db.prepare("UPDATE keep_warm_subscriptions SET status=?,last_error=? WHERE id=?").run(status,message.slice(0,2000),row.id);
      }
      return; // One logical operation, and at most one upstream attempt, per pass.
    }
  } finally {running=false;}
}
export function startKeepWarm():void {
  if(timer) return;
  // No startup refresh, no recursive scheduling. Ticks normally inspect SQLite only.
  timer=setInterval(()=>{void runWarmPass().catch(error=>process.stderr.write(`Keep-warm housekeeping failed: ${String(error)}\n`));},30000);
  timer.unref();
}
export function stopKeepWarm():void {generation++;if(timer) clearInterval(timer);timer=undefined;}
