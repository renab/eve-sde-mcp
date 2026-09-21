import type { Json } from "./nexum-store.js";

/** Pure chain naming and note-planning logic. It deliberately has no HTTP knowledge. */
export type ChainPlan = {
  identifiers: Map<string,string>;
  notes: Array<{systemId:string; signatureId:string; notes:string; connectionId:string}>;
  labels: Array<{systemId:string; identifier:string; serialized:string; actual:string[]}>;
  reservations: Array<{systemId:string; signatureId:string; identifier:string; destinationClass:string}>;
  warnings: string[];
};

/** Galaxy's format for the value it writes into a signature note. */
export const defaultChainNoteFormat="{chain}";
const noteTokens=new Set<string>(["{chain}","{sig}","{dest_type}"]);
export function validateChainNoteFormat(format:unknown):string {
  if(typeof format!=="string"||format.length<1||format.length>240)throw new Error("Chain note format must be 1–240 characters");
  const tokens=(format.match(/\{[^}]+\}/g)??[]) as string[];
  if(tokens.some(token=>!noteTokens.has(token)))throw new Error("Chain note format supports only {chain}, {sig}, and {dest_type}");
  if(!tokens.includes("{chain}"))throw new Error("Chain note format must include {chain}");
  return format;
}
export function formatChainNote(format:string, values:{chain:string;sig:string;destType:string}):string {
  return format.replace(/\{chain\}|\{sig\}|\{dest_type\}/g,token=>token==="{chain}"?values.chain:token==="{sig}"?values.sig:values.destType).trim().replace(/\s+/g," ");
}

const identifier=/^[A-Z](?:\.\d+)*(?:\.(?:HS|LS|NS))?$/;
export const validChainIdentifier=(value:unknown):value is string=>typeof value==="string"&&identifier.test(value);
export function customLabelText(value:unknown):string|undefined {
  if(typeof value!=="string")return undefined;
  return value.startsWith("t:") ? value.slice(2) : value;
}
export function systemIdentifier(system:Json):string|undefined {
  for(const raw of system.customLabels??[]) { const value=customLabelText(raw); if(validChainIdentifier(value))return value; }
  for(const raw of system.labels??[]) if(validChainIdentifier(raw))return raw;
  return undefined;
}
const alpha=(n:number)=>String.fromCharCode(65+n);
const standard=(c:Json)=>!c.broken&&(c.connectionType??"standard")==="standard";
const knownSpace=(s:Json)=>["HS","LS","NS"].includes(String(s.systemClass??"").toUpperCase()) ? String(s.systemClass).toUpperCase() : undefined;
const children=(state:Json,id:string)=>((state.connections??[]) as Json[]).filter(standard).flatMap(c=>
  c.sourceId===id?[{connection:c,other:String(c.targetId)}]:c.targetId===id?[{connection:c,other:String(c.sourceId)}]:[])
  .sort((a,b)=>String(a.connection.id).localeCompare(String(b.connection.id)));
const nextDirect=(used:Set<string>)=>{for(let i=0;i<26;i++){const value=alpha(i);if(!used.has(value))return value;}return undefined;};
const nextChild=(parent:string,used:Set<string>)=>{for(let i=1;i<10000;i++){const value=`${parent}.${i}`;if(!used.has(value))return value;}return undefined;};

export function planChain(state:Json, resources:(systemId:string)=>Json, noteFormat=defaultChainNoteFormat,
  persistedReservations:Array<{systemId:string;signatureId:string;identifier:string;destinationClass:string}>=[]):ChainPlan {
  validateChainNoteFormat(noteFormat);
  const systems=(state.systems??[]) as Json[];
  const byId=new Map(systems.map(s=>[String(s.id),s]));
  const roots=systems.filter(s=>s.isHome);
  const warnings:string[]=[];
  if(roots.length!==1)return {identifiers:new Map(),notes:[],labels:[],reservations:[],warnings:[roots.length?"Multiple Home systems; chain reconciliation deferred":"No Home system; chain reconciliation deferred"]};
  const root=String(roots[0].id), identifiers=new Map<string,string>(), used=new Set<string>();
  for(const s of systems) { const value=systemIdentifier(s); if(value&&String(s.id)!==root&&!used.has(value)){identifiers.set(String(s.id),value);used.add(value);} }
  const reservationBySignature=new Map(persistedReservations.map(row=>[`${row.systemId}\0${row.signatureId}`,row]));
  // Reservations are already-visible branch identities.  They must consume
  // allocator space even before their destination system exists.
  for(const reservation of persistedReservations)used.add(reservation.identifier);
  const matchingScannerSignature=(from:string,to:string,reference:unknown):Json|undefined=>{
    const signatures=resources(from).signatures?.items??[];
    const linked=reference&&signatures.find((s:Json)=>String(s.id)===String(reference));
    if(linked)return linked;
    // Nexum can publish the scanner-side signature before it fills the
    // connection's backing-signature ID. A single exact named destination is
    // enough to attach the operational note; generic class matches are not.
    const target=byId.get(to), targetName=typeof target?.name==="string"?target.name.trim().toLowerCase():"";
    if(!targetName)return undefined;
    const matches=signatures.filter((s:Json)=>s.sigType==="wormhole"&&typeof s.whLeadsTo==="string"&&s.whLeadsTo.trim().toLowerCase()===targetName);
    return matches.length===1?matches[0]:undefined;
  };
  const reservationFor=(from:string,to:string,reference:unknown)=>{
    const signature=matchingScannerSignature(from,to,reference);
    return signature?reservationBySignature.get(`${from}\0${String(signature.id)}`):undefined;
  };
  const queue=[root], visited=new Set<string>([root]);
  while(queue.length) {
    const parent=queue.shift()!, parentIdentifier=identifiers.get(parent);
    for(const {other,connection} of children(state,parent)) {
      if(visited.has(other))continue;
      const destination=byId.get(other);if(!destination)continue;
      const reference=String(connection.sourceId)===parent?connection.sourceSignatureId:connection.targetSignatureId;
      let value=identifiers.get(other)??reservationFor(parent,other,reference)?.identifier;
      if(!value) {
        const terminal=knownSpace(destination);
        if(terminal&&parentIdentifier)value=`${parentIdentifier}.${terminal}`;
        else if(parent===root)value=nextDirect(used);
        else if(parentIdentifier)value=nextChild(parentIdentifier,used);
      }
      if(!value){warnings.push(`Cannot allocate an identifier for ${other}: its parent has no identifier`);continue;}
      if(used.has(value)&&identifiers.get(other)!==value){warnings.push(`Duplicate chain identifier ${value}; leaving ${other} unresolved`);continue;}
      identifiers.set(other,value);used.add(value);visited.add(other);queue.push(other);
    }
  }
  const labels=[...identifiers].map(([systemId,value])=>({systemId,identifier:value,serialized:`t:${value}`,actual:(byId.get(systemId)?.customLabels??[]).map(String)}));
  const notes:ChainPlan["notes"]=[];
  for(const connection of (state.connections??[]) as Json[]) {
    if(!standard(connection))continue;
    for(const [from,to,signatureId] of [[String(connection.sourceId),String(connection.targetId),connection.sourceSignatureId],[String(connection.targetId),String(connection.sourceId),connection.targetSignatureId]] as const) {
      // Home deliberately has no visible system label, but a signature that
      // leads back to it needs the literal operational bookmark destination.
      const destination=identifiers.get(to) ?? (to===root ? "H" : undefined);
      const signature=matchingScannerSignature(from,to,signatureId);
      if(!destination||!signature)continue;
      if(signature)notes.push({systemId:from,signatureId:String(signature.id),notes:formatChainNote(noteFormat,{chain:destination,sig:String(signature.sigId??""),destType:String(byId.get(to)?.systemClass??"")}),connectionId:String(connection.id)});
    }
  }
  const reservations:ChainPlan["reservations"]=[];
  // Give scanners a usable bookmark before they jump or Nexum has created a
  // target node.  The reservation is deliberately keyed by Nexum's stable
  // signature ID, then consumed by the connection pass above when it appears.
  for(const source of [root,...identifiers.keys()]) {
    const parentIdentifier=identifiers.get(source);
    const signatures=[...(resources(source).signatures?.items??[])].filter((s:Json)=>s.sigType==="wormhole"&&typeof s.whLeadsTo==="string"&&s.whLeadsTo.trim());
    for(const signature of signatures.sort((a:Json,b:Json)=>String(a.createdAt??"").localeCompare(String(b.createdAt??""))||String(a.id).localeCompare(String(b.id)))) {
      const key=`${source}\0${String(signature.id)}`;
      // A mapped directional connection already has a more authoritative plan.
      if((state.connections??[]).some((connection:Json)=>standard(connection)&&(
        (String(connection.sourceId)===source&&matchingScannerSignature(source,String(connection.targetId),connection.sourceSignatureId)?.id===signature.id)||
        (String(connection.targetId)===source&&matchingScannerSignature(source,String(connection.sourceId),connection.targetSignatureId)?.id===signature.id)))) continue;
      let reservation=reservationBySignature.get(key);
      if(!reservation) {
        const destinationClass=String(signature.whLeadsTo).trim().toUpperCase();
        const value=source===root?nextDirect(used):(knownSpace({systemClass:destinationClass})&&parentIdentifier?`${parentIdentifier}.${destinationClass}`:parentIdentifier?nextChild(parentIdentifier,used):undefined);
        if(!value){warnings.push(`Cannot reserve an identifier for scanner-side signature ${String(signature.sigId??signature.id)}: its source has no identifier`);continue;}
        reservation={systemId:source,signatureId:String(signature.id),identifier:value,destinationClass};
        reservationBySignature.set(key,reservation);reservations.push(reservation);used.add(value);
      }
      notes.push({systemId:source,signatureId:String(signature.id),notes:formatChainNote(noteFormat,{chain:reservation.identifier,sig:String(signature.sigId??""),destType:reservation.destinationClass}),connectionId:`provisional:${String(signature.id)}`});
    }
  }
  return {identifiers,notes,labels,reservations,warnings};
}
