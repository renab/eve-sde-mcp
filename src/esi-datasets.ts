import { z } from "zod";
import { esiGet, esiGetAll, type EsiRequestOptions } from "./auth/esi-client.js";

export type DatasetRequest = { path: string; options: EsiRequestOptions; pagination: "single" | "all" };
export interface DatasetDefinition {
  name: string; description: string; subject: string; params: z.ZodType;
  requiredScopes: string[];
  build(subject: string, params: any): DatasetRequest;
}
export const datasetRegistry = new Map<string,DatasetDefinition>();
export function registerDataset(definition: DatasetDefinition): void {
  if (datasetRegistry.has(definition.name)) throw new Error(`Dataset ${definition.name} already registered`);
  datasetRegistry.set(definition.name,definition);
}
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export function logicalDataset(name: string, subject: string, params: unknown = {}): { definition: DatasetDefinition; params: any; request: DatasetRequest } {
  const definition = datasetRegistry.get(name);
  if (!definition) throw new Error(`Dataset "${name}" is not yet registered; use list_keep_warm_dataset_types to discover supported adapters`);
  const parsed = definition.params.parse(params);
  return { definition, params: parsed, request: definition.build(subject,parsed) };
}
export async function readDataset<T>(request: DatasetRequest): Promise<T[]> {
  return request.pagination === "all" ? esiGetAll<T>(request.path,request.options) : esiGet<T[]>(request.path,request.options);
}
export function characterAssetsPath(character: number): string { return `/characters/${character}/assets/`; }
export function corporationAssetsPath(corporation: number): string { return `/corporations/${corporation}/assets/`; }
export function walletJournalPath(character: number): string { return `/characters/${character}/wallet/journal/`; }
export function walletTransactionsPath(character: number): string { return `/characters/${character}/wallet/transactions/`; }
export function industryJobsPath(character: number, completed = false): string { return `/characters/${character}/industry/jobs/${completed ? "?include_completed=true" : ""}`; }
for (const [name, builder, scope, pagination] of [
  ["character_assets",characterAssetsPath,"esi-assets.read_assets.v1","all"],
  ["wallet_journal",walletJournalPath,"esi-wallet.read_character_wallet.v1","all"],
  ["wallet_transactions",walletTransactionsPath,"esi-wallet.read_character_wallet.v1","single"],
] as const) registerDataset({name,description:`${name}: same underlying read and pagination as its foreground Galaxy tool`,subject:"character ID",params:z.object({}).strict(),requiredScopes:[scope],
  build:subject=>{const character=id.parse(subject);return {path:builder(character),options:{characterId:character},pagination};}});
registerDataset({name:"corporation_assets",description:"All corporation asset pages; requires an authorized Director character. ESI enforces corporation roles.",subject:"corporation ID",params:z.object({character_id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict(),requiredScopes:["esi-assets.read_corporation_assets.v1"],
  build:(subject,params)=>({path:corporationAssetsPath(id.parse(subject)),options:{characterId:params.character_id},pagination:"all"})});
registerDataset({name:"industry_jobs",description:"Character industry jobs, matching foreground include_completed semantics",subject:"character ID",params:z.object({include_completed:z.boolean().default(false)}).strict(),requiredScopes:["esi-industry.read_character_jobs.v1"],
  build:(subject,params)=>({path:industryJobsPath(id.parse(subject),params.include_completed),options:{characterId:id.parse(subject)},pagination:"single"})});
