import type { Json } from "./nexum-store.js";

/** Pure chain naming and note-planning logic. It deliberately has no HTTP knowledge. */
export type ChainPlan = {
  identifiers: Map<string,string>;
  notes: Array<{systemId:string; signatureId:string; notes:string; connectionId:string}>;
  labels: Array<{systemId:string; identifier:string; serialized:string; actual:string[]}>;
  warnings: string[];
};

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

export function planChain(state:Json, resources:(systemId:string)=>Json):ChainPlan {
  const systems=(state.systems??[]) as Json[];
  const byId=new Map(systems.map(s=>[String(s.id),s]));
  const roots=systems.filter(s=>s.isHome);
  const warnings:string[]=[];
  if(roots.length!==1)return {identifiers:new Map(),notes:[],labels:[],warnings:[roots.length?"Multiple Home systems; chain reconciliation deferred":"No Home system; chain reconciliation deferred"]};
  const root=String(roots[0].id), identifiers=new Map<string,string>(), used=new Set<string>();
  for(const s of systems) { const value=systemIdentifier(s); if(value&&String(s.id)!==root&&!used.has(value)){identifiers.set(String(s.id),value);used.add(value);} }
  const queue=[root], visited=new Set<string>([root]);
  while(queue.length) {
    const parent=queue.shift()!, parentIdentifier=identifiers.get(parent);
    for(const {other} of children(state,parent)) {
      if(visited.has(other))continue;
      const destination=byId.get(other);if(!destination)continue;
      let value=identifiers.get(other);
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
      if(!destination||!signatureId)continue;
      const signatures=resources(from).signatures?.items??[];
      if(signatures.some((s:Json)=>String(s.id)===String(signatureId)))notes.push({systemId:from,signatureId:String(signatureId),notes:destination,connectionId:String(connection.id)});
    }
  }
  return {identifiers,notes,labels,warnings};
}
