import crypto from "node:crypto";
import type Database from "better-sqlite3";

export type Json = Record<string, any>;
export const resourceKinds = ["signatures", "anomalies", "structures"] as const;
export type ResourceKind = typeof resourceKinds[number];
export function canonicalMapId(base: string, id: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([base,id])).digest("hex");
}
export class NexumStore {
  constructor(readonly db: Database.Database, readonly now = Date.now) {
    // Idempotent additive migration: no ledger or ESI table changes.
    db.exec(`
      CREATE TABLE IF NOT EXISTS nexum_credentials (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nexum_maps (id TEXT PRIMARY KEY, base_url TEXT NOT NULL,
        nexum_map_id TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL,
        UNIQUE(base_url,nexum_map_id));
      CREATE TABLE IF NOT EXISTS nexum_map_access (credential_id TEXT NOT NULL REFERENCES nexum_credentials(id) ON DELETE CASCADE,
        canonical_map_id TEXT NOT NULL REFERENCES nexum_maps(id) ON DELETE CASCADE,
        metadata TEXT NOT NULL, PRIMARY KEY(credential_id,canonical_map_id));
      CREATE TABLE IF NOT EXISTS nexum_resources (map_id TEXT NOT NULL REFERENCES nexum_maps(id) ON DELETE CASCADE,
        system_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY(map_id,system_id,kind));
      CREATE TABLE IF NOT EXISTS nexum_presence (map_id TEXT NOT NULL, character_id TEXT NOT NULL,
        payload TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(map_id,character_id));
      CREATE TABLE IF NOT EXISTS nexum_presence_events (id INTEGER PRIMARY KEY, map_id TEXT NOT NULL,
        character_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL, observed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS nexum_presence_time ON nexum_presence_events(map_id,observed_at);
    `);
  }
  credentials(): Json[] { return (this.db.prepare("SELECT metadata FROM nexum_credentials").all() as any[]).map(r=>JSON.parse(r.metadata)); }
  credential(id: string): Json {
    const c = this.credentials().find(c=>c.id===id); if (!c) throw new Error("Credential not found"); return c;
  }
  saveCredential(c: Json): void { this.db.prepare("INSERT OR REPLACE INTO nexum_credentials VALUES (?,?)").run(c.id, JSON.stringify(c)); }
  patchCredential(id: string, patch: Json): void {
    const c={...this.credential(id),...patch,updated_at:this.now()};
    // UPDATE, not REPLACE: preserve foreign-key access bindings.
    this.db.prepare("UPDATE nexum_credentials SET metadata=? WHERE id=?").run(JSON.stringify(c),id);
  }
  maps(): Json[] { return (this.db.prepare("SELECT metadata FROM nexum_maps").all() as any[]).map(r=>JSON.parse(r.metadata)); }
  map(idOrName: string): Json {
    const rows=this.maps().filter(m=>m.id===idOrName || m.name===idOrName);
    if(rows.length!==1) throw new Error(rows.length ? "Ambiguous map name; use canonical map ID" : "Map not found");
    return rows[0];
  }
  state(id: string): Json { const r=this.db.prepare("SELECT state FROM nexum_maps WHERE id=?").get(id) as any; if(!r)throw new Error("Map not found"); return JSON.parse(r.state); }
  saveState(id: string, state: Json): void { this.db.prepare("UPDATE nexum_maps SET state=? WHERE id=?").run(JSON.stringify(state),id); }
  patchMap(id: string, patch: Json): void { this.db.prepare("UPDATE nexum_maps SET metadata=? WHERE id=?").run(JSON.stringify({...this.map(id),...patch}),id); }
  discover(c: Json, maps: Json[]): void {
    this.db.transaction(()=>{
      this.db.prepare("DELETE FROM nexum_map_access WHERE credential_id=?").run(c.id);
      for(const m of maps) {
        const id=canonicalMapId(c.base_url,String(m.id));
        const metadata={id,base_url:c.base_url,nexum_map_id:String(m.id),name:m.name,health:"uninitialized",stream_connected:false,
          hydrated_at:null,last_event_at:null,last_resync_at:null,last_error:null,created_at:this.now()};
        this.db.prepare("INSERT OR IGNORE INTO nexum_maps VALUES (?,?,?,?,?)").run(id,c.base_url,String(m.id),JSON.stringify(metadata),JSON.stringify({systems:[],connections:[],routes:[]}));
        this.db.prepare("INSERT INTO nexum_map_access VALUES (?,?,?)").run(c.id,id,JSON.stringify({...m,last_verified_at:this.now()}));
      }
    })();
  }
  access(mapId?: string): Json[] {
    return (this.db.prepare("SELECT * FROM nexum_map_access"+(mapId ? " WHERE canonical_map_id=?":"")).all(...(mapId?[mapId]:[])) as any[])
      .map(r=>({...r,metadata:JSON.parse(r.metadata)}));
  }
  resources(mapId: string, systemId: string): Json {
    const out: Json={};
    for(const kind of resourceKinds) out[kind]={items:[],status:"uninitialized"};
    for(const r of this.db.prepare("SELECT * FROM nexum_resources WHERE map_id=? AND system_id=?").all(mapId,systemId) as any[])
      out[r.kind]={items:JSON.parse(r.payload),fetched_at:r.fetched_at,status:"cached"};
    return out;
  }
  saveResource(map: string, system: string, kind: ResourceKind, data: Json[]): void {
    this.db.prepare("INSERT OR REPLACE INTO nexum_resources VALUES (?,?,?,?,?)").run(map,system,kind,JSON.stringify(data),this.now());
  }
  presence(mapId: string, event: Json): void {
    const current=this.currentPresence(mapId);
    const change=(p: Json, leaving=false)=>{
      const id=String(p.characterId), previous=current.find(r=>String(r.characterId)===id);
      const changed=leaving ? !!previous : !previous || ["eveSystemId","shipTypeId","characterName"].some(k=>previous[k]!==p[k]);
      if(changed) this.db.prepare("INSERT INTO nexum_presence_events(map_id,character_id,event,payload,observed_at) VALUES (?,?,?,?,?)")
        .run(mapId,id,leaving?"presence.leave":"presence.update",JSON.stringify(leaving?previous:p),this.now());
      if(leaving) this.db.prepare("DELETE FROM nexum_presence WHERE map_id=? AND character_id=?").run(mapId,id);
      else this.db.prepare("INSERT OR REPLACE INTO nexum_presence VALUES (?,?,?,?)").run(mapId,id,JSON.stringify(p),this.now());
    };
    this.db.transaction(()=>{
      if(event.type==="presence.snapshot") {
        for(const p of current) if(!event.viewers.some((v:Json)=>String(v.characterId)===String(p.characterId))) change(p,true);
        for(const p of event.viewers) change(p);
      } else if(event.type==="presence.leave") change(event,true);
      else { const {type,actor,...p}=event; change(p); }
    })();
  }
  currentPresence(map: string): Json[] {
    return (this.db.prepare("SELECT * FROM nexum_presence WHERE map_id=?").all(map) as any[])
      .map(r=>({...JSON.parse(r.payload),observed_at:r.observed_at,provenance:"nexum_presence"}));
  }
  history(map: string, since=0): Json[] {
    // Include last pre-window transition per character as context for approximate reconstruction.
    const rows=this.db.prepare(`SELECT * FROM nexum_presence_events WHERE map_id=? AND
      (observed_at>=? OR id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY character_id ORDER BY observed_at DESC,id DESC) rank
        FROM nexum_presence_events WHERE map_id=? AND observed_at<?) WHERE rank=1))
      ORDER BY observed_at,id`).all(map,since,map,since) as any[];
    return rows.map(r=>({...JSON.parse(r.payload),event:r.event,observed_at:r.observed_at,provenance:"nexum_presence",baseline:r.observed_at<since}));
  }
  prune(retentionMs: number): void {
    const cutoff=this.now()-retentionMs;
    this.db.transaction(()=>{
      // Carry a boundary baseline for an unchanged location that spans the retention window.
      // This is not a new observation; preserve its original timestamp explicitly.
      const previous=this.db.prepare(`SELECT * FROM nexum_presence_events WHERE id IN
        (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY map_id,character_id ORDER BY observed_at DESC,id DESC) rank
          FROM nexum_presence_events WHERE observed_at<?) WHERE rank=1)`).all(cutoff) as any[];
      for(const row of previous)if(row.event!=="presence.leave"){
        const payload=JSON.parse(row.payload);
        this.db.prepare("INSERT INTO nexum_presence_events(map_id,character_id,event,payload,observed_at) VALUES (?,?,?,?,?)")
          .run(row.map_id,row.character_id,"presence.baseline",JSON.stringify({...payload,baseline_from:payload.baseline_from??row.observed_at}),cutoff);
      }
      this.db.prepare("DELETE FROM nexum_presence_events WHERE observed_at<?").run(cutoff);
    })();
  }
}
