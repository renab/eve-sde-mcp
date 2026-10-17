import { parseEsiJson } from "./esi-json.js";
import type { Json } from "./nexum-store.js";

export class NexumError extends Error {
  constructor(readonly status=0, readonly retryAfterMs=0, message="Nexum unavailable") { super(message); }
}
export function normalizeBaseUrl(value: string): string {
  let u: URL; try { u=new URL(value); } catch { throw new NexumError(0,0,"Invalid Nexum base URL"); }
  if(u.protocol!=="https:" || u.username || u.password || u.search || u.hash)
    throw new NexumError(0,0,"Nexum base URL must be HTTPS without credentials, query or fragment");
  return u.href.replace(/\/+$/, "");
}
export interface NexumStream { events: AsyncIterable<Json>; close(): void; }
export interface NexumTransport {
  get(base: string, key: string, endpoint: string, signal?: AbortSignal): Promise<any>;
  post?(base: string, key: string, endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
  patch?(base: string, key: string, endpoint: string, body: Record<string,unknown>, signal?: AbortSignal): Promise<any>;
  put?(base: string, key: string, endpoint: string, body: Record<string,unknown>, signal?: AbortSignal): Promise<any>;
  stream(base: string, key: string, endpoint: string, signal?: AbortSignal): Promise<NexumStream>;
}
const MAX_TOPOLOGY_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_TOPOLOGY_RESPONSE_BYTES = 1024 * 1024;
async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new NexumError(0, 0, "Nexum topology response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
/** Nexum uses unnamed data frames, no event IDs/replay, and comment heartbeats every 25s. */
export async function* decodeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Json> {
  const reader=body.getReader(), decoder=new TextDecoder();
  let buffer="", data:string[]=[], frameSize=0;
  try {
    while(!signal.aborted) {
      const chunk=await reader.read(); if(chunk.done)break;
      buffer+=decoder.decode(chunk.value,{stream:true});
      if(buffer.length>2_000_000)throw new NexumError(0,0,"Nexum event too large");
      let i:number;
      while((i=buffer.indexOf("\n"))>=0) {
        const line=buffer.slice(0,i).replace(/\r$/,""); buffer=buffer.slice(i+1);
        if(line==="") {
          if(data.length) { let e:Json; try{e=parseEsiJson(data.join("\n"));}catch{e={type:"malformed"};} data=[];frameSize=0; yield e; }
          else yield {type:"__heartbeat"};
        } else if(line.startsWith("data:")){frameSize+=line.length;if(frameSize>2_000_000)throw new NexumError(0,0,"Nexum event too large");data.push(line.slice(5).replace(/^ /,""));}
      }
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export class HttpNexumTransport implements NexumTransport {
  private async request(base:string,key:string,endpoint:string,signal:AbortSignal):Promise<Response> {
    try {
      const r=await fetch(base+endpoint,{headers:{Authorization:`Bearer ${key}`,Accept:endpoint.endsWith("/events")?"text/event-stream":"application/json"},redirect:"error",signal});
      if(!r.ok) {
        const retry=r.headers.get("retry-after");
        const ms=retry ? (/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())):0;
        await r.body?.cancel();
        throw new NexumError(r.status,Number.isFinite(ms)?ms:0,`Nexum HTTP ${r.status}`);
      }
      return r;
    }catch(e){if(e instanceof NexumError)throw e; throw new NexumError();}
  }
  async get(base:string,key:string,endpoint:string,signal?:AbortSignal):Promise<any> {
    const s=AbortSignal.any([AbortSignal.timeout(20_000),...(signal?[signal]:[])]);
    const r=await this.request(base,key,endpoint,s);
    try{return parseEsiJson(await r.text());}catch{throw new NexumError(0,0,"Malformed Nexum response");}
  }
  async post(base:string,key:string,endpoint:string,body:Record<string,unknown>,signal?:AbortSignal):Promise<any> {
    const s=AbortSignal.any([AbortSignal.timeout(20_000),...(signal?[signal]:[])]);
    let serialized:string;
    try{serialized=JSON.stringify(body);}catch{throw new NexumError(400,0,"Invalid Nexum JSON request");}
    if(Buffer.byteLength(serialized,"utf8")>256_000)throw new NexumError(413,0,"Nexum ownership request exceeds the size limit");
    try {
      const r=await fetch(base+endpoint,{method:"POST",headers:{Authorization:`Bearer ${key}`,Accept:"application/json","Content-Type":"application/json"},body:serialized,redirect:"error",signal:s});
      if(!r.ok){const retry=r.headers.get("retry-after"),ms=retry?(/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())):0;await r.body?.cancel();throw new NexumError(r.status,Number.isFinite(ms)?ms:0,`Nexum HTTP ${r.status}`);}
      const text=await readBoundedText(r,1024*1024); return text?parseEsiJson(text):{};
    } catch(e){if(e instanceof NexumError)throw e;throw new NexumError();}
  }
  async patch(base:string,key:string,endpoint:string,body:Record<string,unknown>,signal?:AbortSignal):Promise<any> {
    const s=AbortSignal.any([AbortSignal.timeout(20_000),...(signal?[signal]:[])]);
    try {
      const r=await fetch(base+endpoint,{method:"PATCH",headers:{Authorization:`Bearer ${key}`,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(body),redirect:"error",signal:s});
      if(!r.ok){const retry=r.headers.get("retry-after"),ms=retry?(/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())):0;await r.body?.cancel();throw new NexumError(r.status,Number.isFinite(ms)?ms:0,`Nexum HTTP ${r.status}`);}
      const text=await r.text(); return text?parseEsiJson(text):{};
    } catch(e){if(e instanceof NexumError)throw e;throw new NexumError();}
  }
  async put(base:string,key:string,endpoint:string,body:Record<string,unknown>,signal?:AbortSignal):Promise<any> {
    const s=AbortSignal.any([AbortSignal.timeout(20_000),...(signal?[signal]:[])]);
    let serialized:string;
    try{serialized=JSON.stringify(body);}catch{throw new NexumError(400,0,"Invalid Nexum JSON request");}
    if(Buffer.byteLength(serialized,"utf8")>MAX_TOPOLOGY_REQUEST_BYTES)
      throw new NexumError(413,0,"Nexum topology request exceeds the size limit");
    try {
      const r=await fetch(base+endpoint,{method:"PUT",headers:{Authorization:`Bearer ${key}`,Accept:"application/json","Content-Type":"application/json"},body:serialized,redirect:"error",signal:s});
      if(!r.ok){const retry=r.headers.get("retry-after"),ms=retry?(/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())):0;await r.body?.cancel();throw new NexumError(r.status,Number.isFinite(ms)?ms:0,`Nexum HTTP ${r.status}`);}
      const text=await readBoundedText(r,MAX_TOPOLOGY_RESPONSE_BYTES); return text?parseEsiJson(text):{};
    } catch(e){if(e instanceof NexumError)throw e;throw new NexumError();}
  }
  async stream(base:string,key:string,endpoint:string,signal?:AbortSignal):Promise<NexumStream> {
    const controller=new AbortController();
    const s=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
    let timer=setTimeout(()=>controller.abort(),20_000); timer.unref();
    try {
      const r=await this.request(base,key,endpoint,s);
      clearTimeout(timer);
      if(!r.body || !r.headers.get("content-type")?.includes("text/event-stream")) { await r.body?.cancel(); throw new NexumError(0,0,"Invalid Nexum stream"); }
      const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),75_000);timer.unref();};
      reset();
      const events=(async function*(){try{for await(const e of decodeSse(r.body!,s)){reset();yield e;}}finally{clearTimeout(timer);controller.abort();}})();
      return {events,close(){clearTimeout(timer);controller.abort();void r.body?.cancel().catch(()=>{});}};
    }catch(e){clearTimeout(timer);controller.abort();throw e;}
  }
}
