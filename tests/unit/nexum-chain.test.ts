import { describe, expect, it } from "vitest";
import { defaultChainNoteFormat, formatChainNote, planChain, systemIdentifier, validateChainNoteFormat, validChainIdentifier } from "../../src/nexum-chain.js";

const resources=(items:Record<string,any[]>)=>(id:string)=>({signatures:{items:items[id]??[]}});
const systems=[
  {id:"home",name:"Home",isHome:true,systemClass:"C2",customLabels:[]},
  {id:"b",name:"J223207",systemClass:"C2",customLabels:["t:B"]},
  {id:"deep",name:"J132009",systemClass:"C3",customLabels:[]},
  {id:"exit",name:"Erstur",systemClass:"HS",customLabels:[]},
];
const connections=[
  {id:"one",sourceId:"home",targetId:"b",connectionType:"standard",broken:false,sourceSignatureId:"h1",targetSignatureId:"b1"},
  {id:"two",sourceId:"b",targetId:"deep",connectionType:"standard",broken:false,sourceSignatureId:"b2",targetSignatureId:"d1"},
  {id:"three",sourceId:"deep",targetId:"exit",connectionType:"standard",broken:false,sourceSignatureId:"d2",targetSignatureId:"e1"},
];

describe("Nexum chain identifier planner",()=>{
  it("preserves established labels, allocates descendants and writes directional destination notes",()=>{
    const plan=planChain({systems,connections},resources({home:[{id:"h1",notes:"old"}],b:[{id:"b1",notes:""},{id:"b2",notes:""}],deep:[{id:"d1",notes:""},{id:"d2",notes:""}],exit:[{id:"e1",notes:""}]}));
    expect([...plan.identifiers]).toEqual([["b","B"],["deep","B.1"],["exit","B.1.HS"]]);
    expect(plan.notes.map(n=>[n.signatureId,n.notes])).toEqual([["h1","B"],["b1","* H"],["b2","B.1"],["d1","B"],["d2","B.1.HS"],["e1","B.1"]]);
    expect(plan.labels.find(l=>l.systemId==="deep")).toMatchObject({serialized:"t:B.1"});
  });
  it("does not renumber a surviving branch when a sibling disappears",()=>{
    const state={systems:[systems[0],systems[1],{id:"c",name:"Jx",systemClass:"C2",customLabels:["t:C"]}],connections:[connections[0],{id:"c1",sourceId:"home",targetId:"c",connectionType:"standard",sourceSignatureId:null,targetSignatureId:null}]};
    const plan=planChain(state,resources({}));expect(plan.identifiers.get("b")).toBe("B");expect(plan.identifiers.get("c")).toBe("C");
  });
  it("uses one exact scanner-side destination match before Nexum links the signature to the connection",()=>{
    const plan=planChain({systems:[systems[0],systems[1]],connections:[{id:"unlinked",sourceId:"home",targetId:"b",connectionType:"standard",sourceSignatureId:null,targetSignatureId:null}]},resources({home:[{id:"scan-side",sigType:"wormhole",sigId:"ABC-123",whLeadsTo:"J223207",notes:""}]}),"WH | {chain} | {sig} | {dest_type}");
    expect(plan.notes).toEqual([{systemId:"home",signatureId:"scan-side",notes:"WH | B | ABC-123 | C2",connectionId:"unlinked"}]);
  });
  it("reserves and writes a scanner-side identifier before the destination is mapped",()=>{
    const plan=planChain({systems:[systems[0]],connections:[]},resources({home:[{id:"luh",sigId:"LUH-164",sigType:"wormhole",whLeadsTo:"C3",notes:""}]}),"WH | {chain} | {sig} | {dest_type}");
    expect(plan.reservations).toEqual([{systemId:"home",signatureId:"luh",identifier:"A",destinationClass:"C3"}]);
    expect(plan.notes).toEqual([{systemId:"home",signatureId:"luh",notes:"WH | A | LUH-164 | C3",connectionId:"provisional:luh"}]);
  });
  it("does not reuse an identifier already reserved by another scanner-side wormhole",()=>{
    const plan=planChain({systems:[systems[0]],connections:[]},resources({home:[
      {id:"a",sigId:"AAA-001",sigType:"wormhole",whLeadsTo:"C3"},
      {id:"b",sigId:"BBB-002",sigType:"wormhole",whLeadsTo:"C1-C3"},
      {id:"c",sigId:"CCC-003",sigType:"wormhole",whLeadsTo:"LS"},
    ]}),defaultChainNoteFormat,[
      {systemId:"home",signatureId:"a",identifier:"A",destinationClass:"C3"},
      {systemId:"home",signatureId:"b",identifier:"B",destinationClass:"C1-C3"},
    ]);
    expect(plan.reservations).toEqual([{systemId:"home",signatureId:"c",identifier:"C",destinationClass:"LS"}]);
    expect(plan.notes.find(note=>note.signatureId==="c")?.notes).toBe("C");
  });
  it("adopts a scanner-side reservation when its destination becomes a mapped connection",()=>{
    const plan=planChain({systems:[systems[0],{...systems[1],customLabels:[]}],connections:[{id:"c1",sourceId:"home",targetId:"b",connectionType:"standard",sourceSignatureId:"scan"}]},resources({home:[{id:"scan",sigId:"AAA-001",sigType:"wormhole",whLeadsTo:"J223207"}]}),defaultChainNoteFormat,[{systemId:"home",signatureId:"scan",identifier:"A",destinationClass:"C2"}]);
    expect(plan.identifiers.get("b")).toBe("A");
    expect(plan.adoptions).toEqual([{systemId:"home",signatureId:"scan",targetSystemId:"b"}]);
    expect(plan.warnings).toEqual([]);
  });
  it("defers an ambiguous root and ignores broken/non-wormhole links",()=>{
    expect(planChain({systems:[{id:"a",isHome:true},{id:"b",isHome:true}],connections:[]},resources({})).warnings[0]).toMatch(/Multiple Home/);
    const plan=planChain({systems:[systems[0],systems[1]],connections:[{...connections[0],broken:true}]},resources({home:[{id:"h1"}],b:[{id:"b1"}]}));expect(plan.notes).toEqual([]);
  });
  it("accepts text custom labels but never treats arbitrary labels as identifiers",()=>{
    expect(systemIdentifier({customLabels:["t:B.2.LS"]})).toBe("B.2.LS");
    expect(systemIdentifier({customLabels:["t:Scanner"]})).toBeUndefined();
    expect(validChainIdentifier("B.0")).toBe(true);expect(validChainIdentifier("B.HS.1")).toBe(false);
  });
  it("renders complete Galaxy-owned bookmark notes from the mapped destination class",()=>{
    const plan=planChain({systems,connections},resources({home:[{id:"h1",sigId:"AAA-001"}],b:[{id:"b1",sigId:"BBB-002"},{id:"b2",sigId:"BBB-003"}],deep:[{id:"d1",sigId:"DDD-004"},{id:"d2",sigId:"DDD-005"}],exit:[{id:"e1",sigId:"EEE-006"}]}),"WH | {chain} | {sig} | {dest_type}");
    expect(plan.notes.find(n=>n.signatureId==="b1")?.notes).toBe("WH | * H | BBB-002 | C2");
    expect(plan.notes.find(n=>n.signatureId==="d2")?.notes).toBe("WH | B.1.HS | DDD-005 | HS");
    expect(formatChainNote("{chain} {sig}",{chain:"H",sig:"ABC-123",destType:"C2"})).toBe("H ABC-123");
    expect(()=>validateChainNoteFormat("{notes}")).toThrow(/supports only/);
  });
});
