import { z } from "zod";
import { getStateDatabase } from "./persistence.js";
import { getDatabase } from "./database.js";
import { enrichSystemName,enrichTypeName } from "./utils.js";
import { esiGetWithMetadata } from "./auth/esi-client.js";
import { getTokens,getCurrentCharacter } from "./auth/tokens.js";
import { EsiUnavailable } from "./esi-cache.js";

export const structureIdSchema=z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER),z.string().regex(/^[1-9]\d*$/).max(19)]).refine(value=>BigInt(value)<=9223372036854775807n,"ID must fit signed 64-bit range");
const SCOPE="esi-universe.read_structures.v1";
const flights=new Map<string,Promise<any>>();
type Row={payload:string|null;fetched_at:string|null;expires_at:number;next_attempt_at:number;last_error:string|null;last_error_at:string|null};
export async function resolveStructure(value:number|string,characterId?:number,allowStale=true):Promise<any> {
  const id=String(structureIdSchema.parse(value));
  const character=characterId ? getTokens(characterId):getCurrentCharacter();
  const authId=character?.characterId ?? characterId ?? 0;
  const db=getStateDatabase();
  const read=()=>db.prepare("SELECT * FROM structure_resolutions WHERE structure_id=? AND character_id=?").get(id,authId) as Row|undefined;
  const render=(row:Row,stale:boolean)=>{
    const data=JSON.parse(row.payload!);
    return {...data,structure_id:value,solar_system_name:enrichSystemName(getDatabase(),data.solar_system_id),type_name:enrichTypeName(getDatabase(),data.type_id),
      cache:{fetched_at:row.fetched_at,expires_at:new Date(row.expires_at).toISOString(),auth_character_id:authId,stale,
        next_refresh_at:new Date(Math.max(row.expires_at,row.next_attempt_at)).toISOString(),last_error:row.last_error,last_error_at:row.last_error_at}};
  };
  const row=read();
  const authorized=!!character?.scopes.split(" ").includes(SCOPE);
  if(row?.payload && row.expires_at>Date.now() && authorized) return render(row,false);
  if(row && row.next_attempt_at>Date.now()) return row.payload && allowStale ? render(row,true):null;
  const key=`${authId}:${id}`;
  const pending=flights.get(key);
  if(pending) {const result=await pending;return result?.cache.stale && !allowStale ? null:result;}
  const work=(async()=>{
    try {
      if(!authorized) throw new Error(`Missing authenticated character or ${SCOPE}`);
      const snapshot=await esiGetWithMetadata<any>(`/universe/structures/${id}/`,{characterId:authId,allowStale:false});
      const control=snapshot.metadata.esiCacheControl ?? "";
      const expires=snapshot.metadata.localCacheExpiresAt ? Date.parse(snapshot.metadata.localCacheExpiresAt):
        /\b(no-cache|no-store|max-age)\b/.test(control) || snapshot.metadata.esiExpiresAt ? Date.now():Date.now()+4*3600000;
      const fresh:Row={payload:JSON.stringify(snapshot.data),fetched_at:snapshot.metadata.esiFetchedAt,expires_at:expires,next_attempt_at:0,last_error:null,last_error_at:null};
      if(!/\bno-store\b/.test(control)) db.prepare(`INSERT INTO structure_resolutions VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(structure_id,character_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,next_attempt_at=0,last_error=NULL,last_error_at=NULL`)
        .run(id,authId,fresh.payload,fresh.fetched_at,expires,0,null,null);
      else db.prepare("DELETE FROM structure_resolutions WHERE structure_id=? AND character_id=?").run(id,authId);
      return render(fresh,false);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      const retry=Math.max(Date.now()+15*60000,error instanceof EsiUnavailable?error.retryAt:0);
      db.prepare(`INSERT INTO structure_resolutions (structure_id,character_id,next_attempt_at,last_error,last_error_at) VALUES (?,?,?,?,?)
        ON CONFLICT(structure_id,character_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,last_error=excluded.last_error,last_error_at=excluded.last_error_at`)
        .run(id,authId,retry,message.slice(0,2000),new Date().toISOString());
      const old=read();
      return old?.payload ? render(old,true):null;
    }
  })();
  flights.set(key,work);
  try{const result=await work;return result?.cache.stale && !allowStale ? null:result;}finally{flights.delete(key);}
}

const locationKey=/^(structure_id|structureId|station_id|stationId|location_id|locationId|start_location_id|end_location_id|startLocationId|endLocationId|blueprint_location_id|output_location_id|blueprintLocationId|outputLocationId|facility_id|facilityId)$/;
/** Enrich location-bearing ESI tool output once, after its filtering/pagination. */
export async function enrichStructures(value:unknown,characterId?:number):Promise<unknown> {
  const memo=new Map<string,any>();
  let attempted=0;
  const walk=async(v:unknown):Promise<unknown>=>{
    if(Array.isArray(v)){const result=[];for(const item of v) result.push(await walk(item));return result;}
    if(!v || typeof v!=="object") return v;
    const row=v as Record<string,unknown>,result:Record<string,unknown>={...row};
    for(const [key,item] of Object.entries(row)) {
      if(locationKey.test(key) && (typeof item==="string" || typeof item==="number")) {
        // Asset container/item IDs can also be large: respect an explicit non-station discriminator.
        const locationType=row.location_type ?? row.locationType;
        if((key==="location_id" || key==="locationId") && locationType && !["station","other"].includes(String(locationType))) continue;
        if(typeof item==="number" && !Number.isSafeInteger(item)){result[`${key}_resolution_warning`]="Unsafe numeric ID; supply an exact decimal string";continue;}
        if(!/^\d+$/.test(String(item)) || BigInt(item)<1000000000000n) continue;
        const id=String(item);
        if(!memo.has(id)) {
          if(attempted>=10){result[`${key}_resolution_warning`]="Structure enrichment budget reached; use get_structure for remaining IDs";continue;}
          attempted++;
          try{memo.set(id,await resolveStructure(item,characterId));}catch{memo.set(id,null);}
        }
        const metadata=memo.get(id);
        if(metadata) result[/^structure(_id|Id)$/.test(key)?"structure":key.replace(/_id$|Id$/,"")+"_structure"]=metadata;
      } else result[key]=await walk(item);
    }
    return result;
  };
  return walk(value);
}

export async function enrichStructureToolResult(result:any,characterId?:number):Promise<any> {
  if(result?.isError || !Array.isArray(result?.content)) return result;
  try {
    const content=[];
    for(const part of result.content) content.push(part.type==="text"?{...part,text:JSON.stringify(await enrichStructures(JSON.parse(part.text),characterId),null,2)}:part);
    return {...result,content};
  } catch {return result;}
}
