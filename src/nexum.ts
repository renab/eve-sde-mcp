import { NexumEsiLocations, type LocationProvider } from "./nexum-esi.js";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getStateDatabase } from "./persistence.js";
import { Ledger } from "./ledger.js";
import { SecretStore } from "./secrets.js";
import { NexumStore, resourceKinds, type Json, type ResourceKind } from "./nexum-store.js";
import { HttpNexumTransport, NexumError, normalizeBaseUrl, type NexumStream, type NexumTransport } from "./nexum-client.js";
import { defaultChainNoteFormat, planChain, validateChainNoteFormat } from "./nexum-chain.js";

const prefix=(m:Json)=>`/api/v1/maps/${encodeURIComponent(m.nexum_map_id)}`;
const object=(v:any):v is Json=>!!v && typeof v==="object" && !Array.isArray(v);
const idValid=(v:any)=>typeof v==="string" || (typeof v==="number" && Number.isSafeInteger(v));
const safeError=(e:unknown)=>e instanceof NexumError ? e.message : "Nexum synchronization failed";
const presenceCoverage=()=>({
  scope:"map_viewers",
  includes_account_character_locations:false,
  includes_fleet_locations:false,
  limitation:"Nexum's numbered alt and fleet badges use browser-session-only /api/character/account-locations and /api/character/fleet endpoints. Those locations are not included in API-key presence events. A missing viewer does not mean a character is absent from the system.",
});
type Worker={controller:AbortController; task:Promise<void>; credential?:string; stream?:NexumStream};
export interface NexumOptions { debounceMs?:number; staleMs?:number; retentionMs?:number; retryMs?:number; accessRefreshMs?:number; random?:()=>number; }

export class NexumService {
  readonly esiLocations:NexumEsiLocations;
  private workers=new Map<string,Worker>();
  private pending=new Map<string,NodeJS.Timeout>();
  private chainPending=new Map<string,NodeJS.Timeout>();
  private queues=new Map<string,Promise<void>>();
  private pruneTimer?:NodeJS.Timeout;
  private stopped=false;
  private management:Promise<unknown>=Promise.resolve();
  private lifetime=new AbortController();
  private discovering=false;
  readonly options:Required<NexumOptions>;
  constructor(readonly store:NexumStore, private secrets:Pick<SecretStore,"put"|"get"|"remove">,
    private transport:NexumTransport=new HttpNexumTransport(), options:NexumOptions={}, locationProvider?:LocationProvider) {
    this.esiLocations=new NexumEsiLocations(store,locationProvider);
    this.options={debounceMs:250,staleMs:300_000,retentionMs:48*3600_000,retryMs:1000,accessRefreshMs:6*3600_000,random:Math.random,...options};
    for(const k of ["debounceMs","staleMs","retentionMs","retryMs","accessRefreshMs"] as const)
      if(!Number.isFinite(this.options[k])||this.options[k]<=0)throw new Error("Invalid Nexum timing configuration");
  }
  private now(){return this.store.now();}
  private serialize<T>(fn:()=>Promise<T>):Promise<T>{const p=this.management.then(fn);this.management=p.catch(()=>{});return p;}
  private candidates(map:string):Json[]{
    const access=new Set(this.store.access(map).map(a=>a.credential_id));
    return this.store.credentials().filter(c=>access.has(c.id)&&c.enabled&&c.health!=="auth_failed"&&c.health!=="insufficient_scope")
      .sort((a,b)=>(a.health==="healthy"?0:1)-(b.health==="healthy"?0:1));
  }
  private async get(c:Json,endpoint:string,signal?:AbortSignal):Promise<any>{
    const retryAt=this.store.credential(c.id).retry_at??0;
    if(retryAt>this.now())throw new NexumError(429,retryAt-this.now(),"Nexum rate limited");
    return this.transport.get(c.base_url,this.secrets.get(c.secret_ref),endpoint,AbortSignal.any([this.lifetime.signal,...(signal?[signal]:[])]));
  }
  private failure(c:Json,e:unknown,map?:string):void {
    const status=e instanceof NexumError?e.status:0;
    const current=this.store.credential(c.id);
    if(status===0&&["auth_failed","insufficient_scope"].includes(current.health))return;
    this.store.patchCredential(c.id,{health:status===401?"auth_failed":status===403?"insufficient_scope":"degraded",
      last_error:safeError(e),last_error_at:this.now(),retry_at:this.now()+(e instanceof NexumError?e.retryAfterMs:0)});
    if(status===404 && map) this.store.db.prepare("DELETE FROM nexum_map_access WHERE credential_id=? AND canonical_map_id=?").run(c.id,map);
  }
  private async discover(c:Json,key?:string):Promise<Json[]> {
    const result=key!==undefined ? await this.transport.get(c.base_url,key,"/api/v1/maps",this.lifetime.signal) : await this.get(c,"/api/v1/maps");
    if(!object(result)||!Array.isArray(result.maps)||result.maps.some((m:any)=>!object(m)||!idValid(m.id)))throw new NexumError(0,0,"Malformed Nexum maps response");
    return result.maps;
  }
  addCredential(input:{api_key:string;character_id?:string;label?:string;base_url?:string}):Promise<Json>{
    return this.serialize(async()=>{
      const base=normalizeBaseUrl(input.base_url??process.env.NEXUM_BASE_URL??"https://eve-nexum.com");
      const c:Json={id:crypto.randomUUID(),base_url:base,label:input.label??"Nexum",bound_character_id:input.character_id??null,
        bound_character_name:null,identity_source:input.character_id?"caller_supplied":"unavailable",capabilities:["read"],chain_write_status:"unknown",
        scope:null,expiry:null,expiry_known:false,enabled:true,health:"uninitialized",created_at:this.now(),updated_at:this.now()};
      // Reject accidental secret reuse in otherwise safe fields.
      if([c.label,c.bound_character_id,c.base_url].some(v=>typeof v==="string"&&v.includes(input.api_key)))throw new NexumError(0,0,"Secret supplied in metadata");
      const maps=await this.discover(c,input.api_key);
      // Validate events capability once; use a map without an existing stream when possible.
      // For shared maps this short probe is closed before enrollment; never two managed streams.
      let probe:NexumStream|undefined;
      if(maps.length){probe=await this.transport.stream(base,input.api_key,`/api/v1/maps/${encodeURIComponent(String(maps[0].id))}/events`,this.lifetime.signal);probe.close();c.capabilities.push("live_events");}
      c.secret_ref=c.id;c.health="healthy";c.last_success_at=this.now();c.last_discovery_at=this.now();
      this.store.db.transaction(()=>{this.secrets.put(c.secret_ref,input.api_key);this.store.saveCredential(c);this.store.discover(c,maps);})();
      this.ensureWorkers();
      return this.credentialResult(c.id);
    });
  }
  credentialResult(id:string):Json {
    const {secret_ref,...c}=this.store.credential(id);
    return {...c,accessible_maps:this.store.access().filter(a=>a.credential_id===id).map(a=>a.canonical_map_id),
      validation_result:c.health,limitation:"Public API does not expose identity, exact scope or expiry; live_events is probed when a map is accessible."};
  }
  listCredentials():Json[]{return this.store.credentials().map(c=>this.credentialResult(c.id));}
  testCredential(id:string):Promise<Json>{return this.serialize(async()=>{
    const c=this.store.credential(id);
    try{
      const maps=await this.discover(c);
      if(maps.length){const p=await this.transport.stream(c.base_url,this.secrets.get(c.secret_ref),`/api/v1/maps/${encodeURIComponent(String(maps[0].id))}/events`,this.lifetime.signal);p.close();}
      this.store.discover(c,maps);this.store.patchCredential(id,{health:"healthy",capabilities:maps.length?["read","live_events"]:["read"],last_success_at:this.now(),last_discovery_at:this.now(),last_error:null,retry_at:0});
      await this.reconcileWorkers();
    }catch(e){this.failure(c,e);await this.reconcileWorkers();}
    return this.credentialResult(id);
  });}
  updateCredential(id:string,input:{character_id?:string;label?:string;enabled?:boolean;api_key?:string}):Promise<Json>{return this.serialize(async()=>{
    const c=this.store.credential(id);let maps:Json[]|undefined;
    if(input.character_id!==undefined&&(typeof input.character_id!=="string"||!/^[1-9][0-9]{0,19}$/.test(input.character_id)))
      throw new NexumError(0,0,"Character ID must be a positive decimal string of at most 20 digits");
    if(input.label?.includes(input.api_key??this.secrets.get(c.secret_ref)))throw new NexumError(0,0,"Secret supplied in metadata");
    if(input.api_key){
      maps=await this.discover(c,input.api_key);
      if(maps.length){const p=await this.transport.stream(c.base_url,input.api_key,`/api/v1/maps/${encodeURIComponent(String(maps[0].id))}/events`,this.lifetime.signal);p.close();}
    }
    const restart=!!input.api_key||(input.enabled!==undefined&&input.enabled!==c.enabled);
    if(restart)await this.stopCredentialWorkers(id);
    this.store.db.transaction(()=>{
      if(input.api_key)this.secrets.put(c.secret_ref,input.api_key);
      this.store.patchCredential(id,{...(input.label!==undefined?{label:input.label}:{}),...(input.enabled!==undefined?{enabled:input.enabled}:{}),
        ...(input.character_id!==undefined?{bound_character_id:input.character_id,identity_source:"user_confirmed",
          ...(input.character_id!==c.bound_character_id?{bound_character_name:null}:{})}:{}),
        ...(maps?{health:"healthy",capabilities:maps.length?["read","live_events"]:["read"],last_success_at:this.now(),last_discovery_at:this.now(),last_error:null,retry_at:0}: {})});
      if(maps)this.store.discover(c,maps);
    })();
    if(restart)this.ensureWorkers();return this.credentialResult(id);
  });}
  removeCredential(id:string):Promise<Json>{return this.serialize(async()=>{
    const c=this.store.credential(id);await this.stopCredentialWorkers(id);
    this.store.db.transaction(()=>{this.secrets.remove(c.secret_ref);this.store.db.prepare("DELETE FROM nexum_map_access WHERE credential_id=?").run(id);this.store.db.prepare("DELETE FROM nexum_credentials WHERE id=?").run(id);})();
    this.ensureWorkers();return {removed:true,credential_id:id,nexum_key_revoked:false,message:"Removed Galaxy's stored copy. Revoke the key in Nexum separately if desired."};
  });}
  private async stopCredentialWorkers(id:string){
    const tasks:Promise<void>[]=[];
    for(const w of this.workers.values())if(w.credential===id){w.controller.abort();w.stream?.close();tasks.push(w.task);}
    await Promise.allSettled(tasks);
  }
  private async reconcileWorkers(){
    const tasks:Promise<void>[]=[];
    for(const [id,w]of this.workers)if(!this.candidates(id).some(c=>c.id===w.credential)){w.controller.abort();w.stream?.close();tasks.push(w.task);}
    await Promise.allSettled(tasks);this.ensureWorkers();
  }
  start():void {
    this.stopped=false;
    if(this.lifetime.signal.aborted)this.lifetime=new AbortController();
    if(this.pruneTimer)return;
    for(const m of this.store.maps())this.store.patchMap(m.id,{stream_connected:false,health:m.hydrated_at?"degraded":"uninitialized",disconnected_at:this.now()});
    this.pruneTimer=setInterval(()=>{this.store.prune(this.options.retentionMs);this.esiLocations.prune(this.options.retentionMs);this.refreshAccess();this.ensureWorkers();},60_000);this.pruneTimer.unref();
    // Background discovery has bounded HTTP calls and cannot block Galaxy startup.
    this.esiLocations.start();
    this.refreshAccess(true);
  }
  private refreshAccess(force=false):void {
    if(this.stopped||this.discovering)return;this.discovering=true;
    // Auth is checked only at upstream HTTP entry, not during an existing SSE stream.
    // Infrequent map-list checks detect removed access/new maps without full-map polling.
    void this.serialize(async()=>{
      for(const c of this.store.credentials().filter(c=>c.enabled)){
        if(this.stopped)break;
        const interval=c.health==="degraded"?60_000:this.options.accessRefreshMs;
        if(!force&&this.now()-(c.last_discovery_attempt_at??c.last_discovery_at??0)<interval)continue;
        this.store.patchCredential(c.id,{last_discovery_attempt_at:this.now()});
        try{const maps=await this.discover(c);if(this.stopped)break;this.store.discover(c,maps);this.store.patchCredential(c.id,{health:"healthy",last_success_at:this.now(),last_discovery_at:this.now(),last_error:null});}
        catch(e){if(!this.stopped)this.failure(c,e);}
      }
      if(!this.stopped)await this.reconcileWorkers();
    }).catch(()=>{}).finally(()=>this.discovering=false);
  }
  async stop():Promise<void>{
    this.stopped=true;this.lifetime.abort();clearInterval(this.pruneTimer);this.pruneTimer=undefined;
    const esiStopped=this.esiLocations.stop();
    for(const t of this.pending.values())clearTimeout(t);this.pending.clear();
    for(const t of this.chainPending.values())clearTimeout(t);this.chainPending.clear();
    for(const w of this.workers.values()){w.controller.abort();w.stream?.close();}
    await Promise.allSettled([...this.workers.values()].map(w=>w.task));
    await Promise.allSettled([...this.queues.values()]);
    await this.management;
    await esiStopped;
  }
  private ensureWorkers():void {
    if(this.stopped)return;
    for(const m of this.store.maps()) {
      if(this.workers.has(m.id))continue;
      if(!this.candidates(m.id).length){this.store.patchMap(m.id,{stream_connected:false,health:"auth_failed",disconnected_at:m.disconnected_at??this.now()});continue;}
      const w:Worker={controller:new AbortController(),task:Promise.resolve()};this.workers.set(m.id,w);
      w.task=this.run(m.id,w).catch(()=>{this.store.patchMap(m.id,{health:"degraded",last_error:"Nexum worker stopped"});})
        .finally(()=>{if(this.workers.get(m.id)===w)this.workers.delete(m.id);});
    }
  }
  private async delay(ms:number,signal:AbortSignal){if(signal.aborted)return;await new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(t);signal.removeEventListener("abort",done);resolve();};const t=setTimeout(done,ms);t.unref();signal.addEventListener("abort",done,{once:true});
  });}
  private async run(id:string,w:Worker):Promise<void>{
    let failures=0,lastCredential:string|undefined;
    while(!w.controller.signal.aborted&&!this.stopped){
      const candidates=this.candidates(id);if(!candidates.length)break;
      const c=candidates.find(c=>c.id!==lastCredential)??candidates[0];lastCredential=c.id;w.credential=c.id;
      const m=this.store.map(id);let pump:Promise<void>|undefined;
      const session=new AbortController(),signal=AbortSignal.any([w.controller.signal,session.signal]);
      try{
        await this.delay(Math.max(0,(c.retry_at??0)-this.now()),signal);if(signal.aborted)break;
        w.stream=await this.transport.stream(c.base_url,this.secrets.get(c.secret_ref),prefix(m)+"/events",signal);
        const buffered:Json[]=[];let ready=false,ended=false;
        // Subscribe before hydration to cover the REST/stream handoff. Buffer ordered deltas.
        pump=(async()=>{for await(const e of w.stream!.events){
          if(signal.aborted)break;
          if(!ready){if(buffered.length>=10000)throw new NexumError(0,0,"Nexum bootstrap buffer exceeded");buffered.push(e);}
          else await this.enqueue(id,()=>this.handleEvent(id,e,c,signal));
        }ended=true;})().catch(e=>{ended=true;throw e;});
        void pump.catch(()=>{});
        await this.enqueue(id,()=>this.hydrate(id,c,signal));
        if(ended)throw new NexumError();
        while(buffered.length)await this.enqueue(id,()=>this.handleEvent(id,buffered.shift()!,c,signal));
        ready=true;failures=0;
        this.store.patchMap(id,{health:"live",stream_connected:true,stream_credential_id:c.id,disconnected_at:null,last_error:null});
        this.store.patchCredential(c.id,{health:"healthy",capabilities:["read","live_events"],last_success_at:this.now(),last_error:null});
        await pump;if(!signal.aborted)throw new NexumError();
      }catch(e){
        if(!w.controller.signal.aborted){this.failure(c,e,id);failures++;
          this.store.patchMap(id,{last_error:safeError(e),reconnect_attempts:(this.store.map(id).reconnect_attempts??0)+1});}
      }finally{
        session.abort();w.stream?.close();await pump?.catch(()=>{});
        for(const [key,t]of this.pending)if(key.startsWith(id+":")){clearTimeout(t);this.pending.delete(key);}
        const map=this.store.map(id);this.store.patchMap(id,{stream_connected:false,health:this.candidates(id).length?(map.hydrated_at?"degraded":"uninitialized"):"auth_failed",disconnected_at:map.disconnected_at??this.now()});
      }
      await this.delay(Math.min(300_000,this.options.retryMs*2**Math.min(failures,8))*(0.75+this.options.random()*0.5),w.controller.signal);
    }
  }
  private enqueue(id:string,fn:()=>Promise<void>):Promise<void>{
    const next=(this.queues.get(id)??Promise.resolve()).catch(()=>{}).then(fn);this.queues.set(id,next);return next;
  }
  async hydrate(id:string,c:Json,signal?:AbortSignal,mergeResync=false):Promise<void>{
    const m=this.store.map(id),full=await this.get(c,prefix(m),signal);
    if(!object(full)||!Array.isArray(full.systems)||!Array.isArray(full.connections)||full.systems.some((s:any)=>!object(s)||!idValid(s.id)))throw new NexumError(0,0,"Malformed Nexum map");
    // Full-map omits intel. Fetch each resource once per system; no bulk intel endpoint exists.
    const resources:{system:string;kind:ResourceKind;data:Json[]}[]=[];
    for(const s of full.systems)for(const kind of resourceKinds){
      // The only audited map.resync producer is merge, which never copies anomalies.
      // Preserve existing anomaly snapshots (or the empty list of a newly merged node).
      if(mergeResync&&kind==="anomalies")continue;
      let data:any;
      try {data=await this.get(c,`${prefix(m)}/systems/${encodeURIComponent(String(s.id))}/${kind}`,signal);}
      catch(e){if(e instanceof NexumError&&e.status===404)throw new NexumError(0,0,"Nexum system changed during hydration");throw e;}
      if(!Array.isArray(data))throw new NexumError(0,0,"Malformed Nexum resource");resources.push({system:String(s.id),kind,data});
    }
    if(signal?.aborted)return;
    this.store.db.transaction(()=>{
      this.store.saveState(id,full);
      if(mergeResync){
        const ids=new Set(full.systems.map((s:Json)=>String(s.id)));
        const old=this.store.db.prepare("SELECT DISTINCT system_id FROM nexum_resources WHERE map_id=?").all(id) as any[];
        for(const r of old)if(!ids.has(r.system_id))this.store.db.prepare("DELETE FROM nexum_resources WHERE map_id=? AND system_id=?").run(id,r.system_id);
        for(const s of full.systems)if(this.store.resources(id,String(s.id)).anomalies.status==="uninitialized")this.store.saveResource(id,String(s.id),"anomalies",[]);
      }else this.store.db.prepare("DELETE FROM nexum_resources WHERE map_id=?").run(id);
      for(const r of resources){
        this.store.saveResource(id,r.system,r.kind,r.data);
        if(r.kind==="signatures")this.store.retireAbsentChainReservations(id,r.system,r.data,full);
      }
      this.store.patchMap(id,{name:full.name,hydrated_at:this.now(),last_rest_success_at:this.now(),last_resync_at:m.hydrated_at?this.now():null});
    })();
    this.scheduleChain(id,c);
  }
  private scheduleChain(id:string,c:Json):void {
    if(this.chainPending.has(id))return;
    const timer=setTimeout(()=>{this.chainPending.delete(id);void this.enqueue(id,async()=>{await this.reconcileChain(id,c);});},this.options.debounceMs);
    timer.unref();this.chainPending.set(id,timer);
  }
  private async reconcileChain(id:string,c:Json):Promise<void> {
    const m=this.store.map(id), noteFormat=this.chainNoteFormat(id).format;
    let plan=planChain(this.store.state(id),systemId=>this.store.resources(id,systemId),noteFormat,this.store.chainReservations(id));
    if(plan.reservations.length){this.store.saveChainReservations(id,plan.reservations);plan=planChain(this.store.state(id),systemId=>this.store.resources(id,systemId),noteFormat,this.store.chainReservations(id));}
    if(plan.adoptions.length)this.store.adoptChainReservations(id,plan.adoptions);
    // The stream credential can be read/events-only. Prefer any other healthy
    // credential with map access that has not already proven unable to write.
    const current=this.store.credential(c.id);
    const writer=(current.chain_write_status??"unknown")==="unavailable"
      ? this.candidates(id).find(candidate=>(candidate.chain_write_status??"unknown")!=="unavailable")??current
      : current;
    const status=writer.chain_write_status??"unknown";
    const changes=plan.notes.filter(change=>{
      const signatures=this.store.resources(id,change.systemId).signatures.items as Json[];
      return signatures.find(s=>String(s.id)===change.signatureId)?.notes!==change.notes;
    });
    const labelChanges=plan.labels.filter(label=>!label.actual.includes(label.serialized));
    this.store.patchMap(id,{chain_sync:{at:this.now(),note_format:noteFormat,identifier_count:plan.identifiers.size,desired_note_changes:changes.length,
      desired_label_changes:labelChanges.length,label_write_status:"unavailable_by_external_api",warnings:plan.warnings}});
    if(!changes.length||status==="unavailable")return;
    if(!this.transport.patch){this.store.patchCredential(writer.id,{chain_write_status:"unavailable",chain_write_error:"Configured Nexum transport has no PATCH support"});return;}
    for(const change of changes) {
      try {
        await this.transport.patch(writer.base_url,this.secrets.get(writer.secret_ref),`${prefix(m)}/systems/${encodeURIComponent(change.systemId)}/signatures/${encodeURIComponent(change.signatureId)}`,{notes:change.notes},this.lifetime.signal);
        const resource=this.store.resources(id,change.systemId), rows=(resource.signatures.items as Json[]).map(s=>String(s.id)===change.signatureId?{...s,notes:change.notes}:s);
        this.store.saveResource(id,change.systemId,"signatures",rows);
        this.store.patchCredential(writer.id,{chain_write_status:"available",chain_write_error:null,last_chain_write_at:this.now()});
      } catch(e) {
        if(e instanceof NexumError&&[401,403].includes(e.status))this.store.patchCredential(writer.id,{chain_write_status:"unavailable",chain_write_error:safeError(e),chain_write_error_at:this.now()});
        else this.store.patchCredential(writer.id,{chain_write_status:"degraded",chain_write_error:safeError(e),chain_write_error_at:this.now()});
        this.store.patchMap(id,{chain_sync:{...(this.store.map(id).chain_sync??{}),last_error:safeError(e),at:this.now()}});return;
      }
    }
  }
  private schedule(id:string,key:string,fn:()=>Promise<void>):void {
    const k=id+":"+key;if(this.pending.has(k))return;
    const t=setTimeout(()=>{this.pending.delete(k);void this.enqueue(id,fn).catch(e=>{
      this.store.patchMap(id,{health:"degraded",last_error:safeError(e)});
      // A failed targeted refresh must recover even if no further event arrives.
      const w=this.workers.get(id);
      if(w?.credential)this.failure(this.store.credential(w.credential),e);
      w?.stream?.close();
    });},this.options.debounceMs);t.unref();this.pending.set(k,t);
  }
  async handleEvent(id:string,e:Json,c:Json,signal?:AbortSignal):Promise<void>{
    if(signal?.aborted)return;
    if(!object(e)||typeof e.type!=="string"){this.store.patchMap(id,{last_error:"Malformed Nexum event"});return;}
    if(e.type==="__heartbeat"){this.store.patchMap(id,{last_stream_activity_at:this.now()});return;}
    this.store.patchMap(id,{last_event_at:this.now(),last_stream_activity_at:this.now()});
    if(e.type.startsWith("presence.")){
      const valid=e.type==="presence.snapshot"?Array.isArray(e.viewers)&&e.viewers.every((p:any)=>object(p)&&idValid(p.characterId)):
        ["presence.update","presence.leave"].includes(e.type)&&idValid(e.characterId);
      if(valid)this.store.presence(id,e);else this.store.patchMap(id,{last_error:"Unknown or malformed Nexum presence event"});return;
    }
    const kind=({"sig.changed":"signatures","anom.changed":"anomalies","structure.changed":"structures"} as Record<string,ResourceKind>)[e.type];
    if(kind){
      if(!idValid(e.systemId)){this.store.patchMap(id,{last_error:"Malformed Nexum invalidation"});return;}
      if(kind!=="anomalies"&&this.pending.has(id+":resync"))return;
      this.schedule(id,`${e.systemId}:${kind}`,async()=>{
        if(signal?.aborted||!this.store.state(id).systems.some((s:Json)=>String(s.id)===String(e.systemId)))return;
        const data=await this.get(c,`${prefix(this.store.map(id))}/systems/${encodeURIComponent(String(e.systemId))}/${kind}`,signal);
        if(!Array.isArray(data))throw new NexumError(0,0,"Malformed Nexum resource");
        if(!signal?.aborted){
          this.store.saveResource(id,String(e.systemId),kind,data);
          if(kind==="signatures")this.store.retireAbsentChainReservations(id,String(e.systemId),data,this.store.state(id));
          this.store.patchMap(id,{last_rest_success_at:this.now()});this.scheduleChain(id,c);
        }
      });return;
    }
    if(e.type==="map.resync"){
      for(const [k,t]of this.pending)if(k.startsWith(id+":")&&!k.endsWith(":anomalies")){clearTimeout(t);this.pending.delete(k);}
      this.schedule(id,"resync",()=>this.hydrate(id,c,signal,true));return;
    }
    const state=this.store.state(id),match=/^(system|connection|route)\.(add|update|remove)$/.exec(e.type);
    if(match){
      const [,entity,action]=match,collection=entity==="system"?"systems":entity==="connection"?"connections":"routes";
      const rows:Json[]=state[collection]??[];
      if(action==="add"&&object(e[entity])&&idValid(e[entity].id)){
        if(!rows.some(r=>r.id===e[entity].id)){
          rows.push(e[entity]);
          // The audited system.add inserts a new empty system; content changes have their own invalidations.
          if(entity==="system")for(const k of resourceKinds)this.store.saveResource(id,String(e.system.id),k,[]);
        }
      }else if(action==="update"&&idValid(e.id)&&object(e.updates)){
        const r=rows.find(r=>r.id===e.id);if(r){
          const {id:ignored,...patch}=e.updates;
          if(entity==="system"){
            if(object(patch.position))patch.position={...r.position,...patch.position};
            if(typeof patch.alias==="string")patch.alias=patch.alias.trim().slice(0,32)||null;
            if(Array.isArray(patch.labels))patch.labels=[...new Set(patch.labels)];
          }
          Object.assign(r,patch);
        }
      }else if(action==="remove"&&idValid(e.id)){
        state[collection]=rows.filter(r=>r.id!==e.id);
        if(entity==="system"){
          state.connections=state.connections.filter((r:Json)=>r.sourceId!==e.id&&r.targetId!==e.id);
          this.store.db.prepare("DELETE FROM nexum_resources WHERE map_id=? AND system_id=?").run(id,String(e.id));
        }
      }else {this.store.patchMap(id,{last_error:"Malformed Nexum topology event"});return;}
      if(action!=="remove")state[collection]=rows;
    }else if(e.type==="map.meta"){
      const fields=["name","locked","allowAsMergeSource","allowAsMergeDestination","skipKspace","lazyRemoveWormholes","collapseGraceHours","bookmarkFormat","siteBookmarkFormat"];
      for(const k of fields)if(k in e)state[k]=e[k];
      if(typeof e.name==="string")this.store.patchMap(id,{name:e.name});
    }else if(e.type==="route.reorder"&&Array.isArray(e.orderedIds)){
      const ids=[...new Set(e.orderedIds)];state.routes=[...ids.map(i=>(state.routes??[]).find((r:Json)=>r.id===i)).filter(Boolean),...(state.routes??[]).filter((r:Json)=>!ids.includes(r.id))];
    }else if(e.type==="kill.recent"&&idValid(e.killmailId)){
      state.recent_kills=[e,...(state.recent_kills??[]).filter((r:Json)=>r.killmailId!==e.killmailId)].slice(0,100);
    }else if(["jump.logged","jump.updated"].includes(e.type)&&object(e.jump)&&idValid(e.jump.id)){
      state.recent_jumps=[e.jump,...(state.recent_jumps??[]).filter((r:Json)=>r.id!==e.jump.id)].slice(0,500);
    }else if(e.type==="jump.cleared"&&idValid(e.connectionId)){
      state.recent_jumps=(state.recent_jumps??[]).filter((r:Json)=>r.connectionId!==e.connectionId);
    }else {this.store.patchMap(id,{last_error:"Unknown or malformed Nexum event ignored"});return;}
    this.store.saveState(id,state);this.scheduleChain(id,c);
  }
  freshness(id:string):Json {
    const m=this.store.map(id);let health=m.health;
    if(!m.stream_connected&&m.hydrated_at&&this.now()-(m.disconnected_at??m.hydrated_at)>this.options.staleMs)health="stale";
    return {...m,health,warning:health==="live"&&!m.last_error?null:"Cached Nexum data may be incomplete or out of date"};
  }
  listMaps():Json[]{return this.store.maps().map(m=>({...this.freshness(m.id),access:this.store.access(m.id).map(a=>({credential_id:a.credential_id,
    character_id:this.store.credential(a.credential_id).bound_character_id,metadata:a.metadata}))}));}
  mapState(map:string):Json{const m=this.store.map(map);return {map:this.store.state(m.id),freshness:this.freshness(m.id)};}
  private coverage(map:string):Json {return {...presenceCoverage(),esi_augmentation:this.esiLocations.coverage(map),
    supplementation:"ESI location for bound characters; online status unknown. Not Nexum account or fleet API data."};}
  private mergedPresence(map:string):Json[] {
    const groups=new Map<string,Json[]>();
    for(const p of [...this.store.currentPresence(map),...this.esiLocations.current(map)]) {
      const id=String(p.characterId);groups.set(id,[...(groups.get(id)??[]),p]);
    }
    return [...groups.values()].map(observations=>{
      observations.sort((a,b)=>(b.provenance==="nexum_presence"?(b.ts??b.observed_at):b.observed_at)-(a.provenance==="nexum_presence"?(a.ts??a.observed_at):a.observed_at));
      const selected=observations[0];
      return {...selected,observations,location_conflict:new Set(observations.filter(p=>p.eveSystemId!=null).map(p=>String(p.eveSystemId))).size>1,
        in_map:this.store.state(map).systems.some((s:Json)=>String(s.eveSystemId)===String(selected.eveSystemId))};
    });
  }
  systemState(map:string,system:string):Json{
    const m=this.store.map(map),state=this.store.state(m.id),s=state.systems.filter((s:Json)=>String(s.id)===system||s.name===system||String(s.eveSystemId)===system);
    if(s.length!==1)throw new Error("System not found or ambiguous");
    return {system:s[0],...this.store.resources(m.id,String(s[0].id)),connections:state.connections.filter((c:Json)=>c.sourceId===s[0].id||c.targetId===s[0].id),
      presence:this.mergedPresence(m.id).filter(p=>p.eveSystemId!=null&&String(p.eveSystemId)===String(s[0].eveSystemId)),presence_coverage:this.coverage(m.id),freshness:this.freshness(m.id)};
  }
  presence(map:string,options:{character?:string;system?:string;current_only?:boolean;since?:number}={}):Json{
    const m=this.store.map(map);this.store.prune(this.options.retentionMs);this.esiLocations.prune(this.options.retentionMs);
    const rows=options.current_only===false?[...this.store.history(m.id,options.since),...this.esiLocations.history(m.id,options.since)].sort((a,b)=>a.observed_at-b.observed_at):this.mergedPresence(m.id);
    return {presence:rows.filter(p=>(!options.character||String(p.characterId)===options.character||p.characterName===options.character)&&
      (!options.system||String(p.eveSystemId)===options.system)&& (options.current_only===false||options.since===undefined||p.observed_at>=options.since)),
      provenance:"source_labeled_telemetry",presence_coverage:this.coverage(m.id),interpretation:"Nexum viewers supplemented by ESI locations of bound, ESI-authorized characters. Location does not prove online status. Conflicts retain both observations; selected location uses the latest source timestamp. Telemetry is not an explicit user report. Leaving the viewer roster is not proof of leaving the system.",freshness:this.freshness(m.id)};
  }
  chain(map:string,options:{root?:string;depth?:number;include_presence?:boolean;include_sites?:boolean}={}):Json{
    const m=this.store.map(map),state=this.store.state(m.id);let selected=new Set(state.systems.map((s:Json)=>s.id));
    if(options.root){
      const roots=state.systems.filter((s:Json)=>s.id===options.root||s.name===options.root||String(s.eveSystemId)===options.root);
      if(roots.length!==1)throw new Error("Root system not found or ambiguous");selected=new Set([roots[0].id]);let frontier=[roots[0].id];
      for(let i=0;i<(options.depth??3);i++){const next:any[]=[];for(const c of state.connections){const n=frontier.includes(c.sourceId)?c.targetId:frontier.includes(c.targetId)?c.sourceId:undefined;if(n&&!selected.has(n)){selected.add(n);next.push(n);}}frontier=next;}
    }
    const systems=state.systems.filter((s:Json)=>selected.has(s.id));
    return {map_id:m.id,name:state.name,systems:systems.map((s:Json)=>({id:s.id,name:s.name,eve_system_id:s.eveSystemId,class:s.systemClass,security:s.security,notes:s.notes,
      structures:this.store.resources(m.id,String(s.id)).structures,...(options.include_sites?{sites:this.store.resources(m.id,String(s.id))}:{})})),
      connections:state.connections.filter((c:Json)=>selected.has(c.sourceId)&&selected.has(c.targetId)).map((c:Json)=>({
        id:c.id,source:systems.find((s:Json)=>s.id===c.sourceId)?.name??c.sourceId,destination:systems.find((s:Json)=>s.id===c.targetId)?.name??c.targetId,
        wormhole_type:c.type,connection_type:c.connectionType,source_signature_id:c.sourceSignatureId,target_signature_id:c.targetSignatureId,
        lifetime_state:c.timeStatus,mass_state:c.massStatus,mass_used:c.massUsed,created_at:c.createdAt,eol_at:c.eolAt,lifetime_expires_at:c.lifetimeExpiresAt,broken:c.broken,notes:c.flagNote})),
      ...(options.include_presence?{presence:this.mergedPresence(m.id).filter(p=>p.eveSystemId!=null&&systems.some((s:Json)=>String(s.eveSystemId)===String(p.eveSystemId))),presence_coverage:this.coverage(m.id)}:{}),freshness:this.freshness(m.id)};
  }
  private chainNoteFormat(mapId:string):{format:string;record:Json|null;error:string|null}{
    const record=new Ledger(this.store.db).get({namespace:"nexum",kind:"chain_note_format",key:mapId});
    if(!record)return {format:defaultChainNoteFormat,record:null,error:null};
    try{return {format:validateChainNoteFormat(record.payload.format),record,error:null};}
    catch(e){return {format:defaultChainNoteFormat,record,error:e instanceof Error?e.message:"Invalid chain note format record"};}
  }
  reconcileChainNotes(map:string):Promise<Json>{return this.serialize(async()=>{
    const m=this.store.map(map),credential=this.candidates(m.id)[0];
    if(credential)await this.reconcileChain(m.id,credential);
    return this.chainDiagnostics(m.id);
  });}
  chainDiagnostics(map:string):Json {
    const m=this.store.map(map),state=this.store.state(m.id),config=this.chainNoteFormat(m.id),noteFormat=config.format,plan=planChain(state,systemId=>this.store.resources(m.id,systemId),noteFormat,this.store.chainReservations(m.id));
    const systems=(state.systems??[]) as Json[];
    return {map_id:m.id,map_name:state.name,write_capability:this.candidates(m.id).map(c=>({credential_id:c.id,status:c.chain_write_status??"unknown",error:c.chain_write_error??null})),
      note_format:noteFormat,note_format_record:config.record?{id:config.record.id,namespace:config.record.namespace,kind:config.record.kind,key:config.record.key,status:config.record.status,source_type:config.record.source_type,payload:config.record.payload}:null,note_format_error:config.error,nexum_bookmark_format_required:"{notes}",custom_label_write:"unavailable_by_external_api: Nexum API keys cannot PATCH systems/customLabels; browser-session system editing is required upstream.",
      systems:systems.map(s=>({system_id:s.id,name:s.name,is_home:!!s.isHome,actual_custom_labels:s.customLabels??[],effective_identifier:plan.identifiers.get(String(s.id))??null,desired_custom_label:plan.identifiers.has(String(s.id))?`t:${plan.identifiers.get(String(s.id))}`:null})),
      signature_notes:plan.notes.map(n=>({connection_id:n.connectionId,system_id:n.systemId,signature_id:n.signatureId,desired_note:n.notes,actual_note:(this.store.resources(m.id,n.systemId).signatures.items as Json[]).find(s=>String(s.id)===n.signatureId)?.notes??null})),
      provisional_reservations:[...this.store.chainReservations(m.id),...plan.reservations],warnings:plan.warnings,freshness:this.freshness(m.id)};
  }
  diagnostics():Json{return {credential_count:this.store.credentials().length,credentials:this.listCredentials(),maps:this.listMaps(),
    presence_history_rows:(this.store.db.prepare("SELECT count(*) n FROM nexum_presence_events").get() as any).n};}
}

let service:NexumService|undefined;
export function getNexum():NexumService{
  if(!service){const db=getStateDatabase(),dir=path.dirname(process.env.GALAXY_STATE_DB??path.join(os.homedir(),".eve-sde","galaxy-state.db"));
    service=new NexumService(new NexumStore(db),new SecretStore(db,path.join(dir,"galaxy-secret.key")),undefined,{
      retentionMs:Number(process.env.NEXUM_PRESENCE_RETENTION_HOURS??48)*3600_000,staleMs:Number(process.env.NEXUM_STALE_SECONDS??300)*1000});}
  return service;
}
export function startNexum():void {try{getNexum().start();}catch{process.stderr.write("Nexum startup unavailable; Galaxy remains available\n");}}
export async function stopNexum():Promise<void>{await service?.stop();service=undefined;}
