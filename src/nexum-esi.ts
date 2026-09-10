import { listCharacters } from "./auth/tokens.js";
import { esiGetWithMetadata } from "./auth/esi-client.js";
import { isIdle, runBackground, WarmDeferred } from "./work-priority.js";
import type { NexumStore, Json } from "./nexum-store.js";

const scope = "esi-location.read_location.v1";
export interface LocationProvider {
  characters(): {characterId:number;characterName:string;scopes:string}[];
  read(id:number): Promise<{data:Json;metadata:{esiFetchedAt:string;localCacheExpiresAt:string|null;cacheStatus:string}}>;
}
const provider:LocationProvider={characters:()=>listCharacters(),
  read:id=>esiGetWithMetadata(`/characters/${id}/location/`,{characterId:id,allowStale:false})};

/** One location observation per ESI character, shared across all accessible Nexum maps. */
export class NexumEsiLocations {
  private timer?:NodeJS.Timeout;
  private running?:Promise<void>;
  private stopped=true;
  private cursor=0;
  constructor(private store:NexumStore,private source:LocationProvider=provider) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS nexum_esi_locations
      (character_id TEXT PRIMARY KEY,payload TEXT NOT NULL,next_attempt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nexum_esi_location_events
      (id INTEGER PRIMARY KEY,character_id TEXT NOT NULL,payload TEXT NOT NULL,observed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS nexum_esi_location_time ON nexum_esi_location_events(character_id,observed_at);`);
  }
  private bindings(map?:string):Set<string> {
    const access=new Set(this.store.access(map).map(a=>a.credential_id));
    return new Set(this.store.credentials().filter(c=>c.enabled&&access.has(c.id)&&c.bound_character_id)
      .map(c=>String(c.bound_character_id)));
  }
  private authorized() { try{return this.source.characters().filter(c=>c.scopes.split(" ").includes(scope));}catch{return [];} }
  private saved(id:string):Json|undefined {
    const row=this.store.db.prepare("SELECT * FROM nexum_esi_locations WHERE character_id=?").get(id) as any;
    return row?{...JSON.parse(row.payload),next_attempt:row.next_attempt}:undefined;
  }
  start():void {
    if(this.timer)return;this.stopped=false;
    this.timer=setInterval(()=>{void this.tick();},10_000);this.timer.unref();
  }
  async stop():Promise<void> {this.stopped=true;clearInterval(this.timer);this.timer=undefined;await this.running;}
  async tick():Promise<void> {
    if(this.stopped||this.running||!isIdle())return;
    this.running=this.sample().catch(()=>{}).finally(()=>{this.running=undefined;});await this.running;
  }
  private async sample():Promise<void> {
    const bound=this.bindings(),chars=this.authorized().filter(c=>bound.has(String(c.characterId)));
    // Fair rotation, at most one character per pass. Cache expiry and ESI backoff still apply.
    for(let n=0;n<chars.length;n++) {
      const c=chars[this.cursor++%chars.length],id=String(c.characterId),old=this.saved(id),now=this.store.now();
      if((old?.next_attempt??0)>now)continue;
      try {
        const result=await runBackground(()=>this.source.read(c.characterId),()=>!this.stopped&&this.bindings().has(id));
        if(this.stopped||!this.bindings().has(id))return;
        const {data,metadata}=result,observed=Date.parse(metadata.esiFetchedAt);
        if(!Number.isSafeInteger(data.solar_system_id)||data.solar_system_id<=0||!Number.isFinite(observed)||metadata.cacheStatus==="stale_on_error")throw new Error("Invalid location");
        const payload:Json={characterId:id,characterName:c.characterName,eveSystemId:data.solar_system_id,
          station_id:data.station_id??null,structure_id:data.structure_id??null,shipTypeId:null,online:null,
          observed_at:observed,expires_at:metadata.localCacheExpiresAt,provenance:"esi_location",status:"available"};
        this.store.db.transaction(()=>{
          if(!old||["eveSystemId","station_id","structure_id"].some(k=>old[k]!==payload[k]))
            this.store.db.prepare("INSERT INTO nexum_esi_location_events(character_id,payload,observed_at) VALUES (?,?,?)").run(id,JSON.stringify(payload),observed);
          this.store.db.prepare("INSERT OR REPLACE INTO nexum_esi_locations VALUES (?,?,?)")
            .run(id,JSON.stringify(payload),Math.max(now+30_000,Date.parse(metadata.localCacheExpiresAt??"")||0));
        })();
      } catch(error) {
        if(error instanceof WarmDeferred||this.stopped)return;
        const payload:Json={...old,characterId:id,characterName:c.characterName,provenance:"esi_location",status:"unavailable",last_error:"ESI location unavailable; check ESI authorization or retry later"};
        delete payload.next_attempt;
        this.store.db.prepare("INSERT OR REPLACE INTO nexum_esi_locations VALUES (?,?,?)").run(id,JSON.stringify(payload),now+60_000);
      }
      return;
    }
  }
  coverage(map:string):Json[] {
    if(!this.bindings(map).size)return [];
    const auth=new Set(this.authorized().map(c=>String(c.characterId)));
    return [...this.bindings(map)].map(id=>({character_id:id,status:!auth.has(id)?"missing_esi_location_authorization":this.saved(id)?.status??"awaiting_observation"}));
  }
  current(map:string):Json[] {
    if(!this.bindings(map).size)return [];
    const auth=new Set(this.authorized().map(c=>String(c.characterId)));
    return [...this.bindings(map)].filter(id=>auth.has(id)).flatMap(id=>{
      const p=this.saved(id);if(!p?.eveSystemId)return [];
      const {next_attempt,...out}=p;
      return [{...out,stale:p.status!=="available"||!(Date.parse(p.expires_at??"")>this.store.now()),location_only:true}];
    });
  }
  history(map:string,since=0):Json[] {
    return [...this.bindings(map)].flatMap(id=>{
      const rows=this.store.db.prepare(`SELECT * FROM nexum_esi_location_events WHERE character_id=? AND
        (observed_at>=? OR id=(SELECT id FROM nexum_esi_location_events WHERE character_id=? AND observed_at<? ORDER BY observed_at DESC,id DESC LIMIT 1))
        ORDER BY observed_at,id`).all(id,since,id,since) as any[];
      return rows.map(r=>{const p=JSON.parse(r.payload);return {...p,event:p.baseline_from!==undefined?"esi.location.baseline":"esi.location",baseline:p.baseline_from!==undefined||r.observed_at<since};});
    });
  }
  prune(retention:number):void {
    const cutoff=this.store.now()-retention;
    this.store.db.transaction(()=>{
      const rows=this.store.db.prepare(`SELECT * FROM nexum_esi_location_events WHERE id IN
        (SELECT id FROM (SELECT id,ROW_NUMBER() OVER (PARTITION BY character_id ORDER BY observed_at DESC,id DESC) rank
        FROM nexum_esi_location_events WHERE observed_at<?) WHERE rank=1)`).all(cutoff) as any[];
      for(const row of rows){const p=JSON.parse(row.payload);this.store.db.prepare("INSERT INTO nexum_esi_location_events(character_id,payload,observed_at) VALUES (?,?,?)")
        .run(row.character_id,JSON.stringify({...p,observed_at:cutoff,baseline_from:p.baseline_from??p.observed_at}),cutoff);}
      this.store.db.prepare("DELETE FROM nexum_esi_location_events WHERE observed_at<?").run(cutoff);
    })();
  }
}
