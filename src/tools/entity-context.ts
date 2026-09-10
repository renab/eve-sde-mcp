import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EntityIndex, entityType, entityId, entityRef, discoverSources, explicitSources, type SourcePointer } from "../entities.js";
import { getStateDatabase } from "../persistence.js";
import { getDatabase } from "../database.js";
import { esiGetWithMetadata, getActiveCharacter } from "../auth/esi-client.js";
import { jsonResult } from "../utils.js";
import { resolveStructure } from "../structures.js";

async function resolveSource(pointer: SourcePointer) {
  const args = pointer.arguments;
  if (pointer.subsystem === "esi_structure") {
    const char = await getActiveCharacter();
    if (!char.scopes.split(" ").includes("esi-universe.read_structures.v1")) throw new Error("Character requires esi-universe.read_structures.v1");
    const data = await resolveStructure(String(args.structure_id), char.characterId);
    if (!data) throw new Error("Structure metadata unavailable for this character");
    return { data };
  }
  if (pointer.subsystem === "sde_system") return { data: getDatabase().prepare("SELECT * FROM mapSolarSystems WHERE solarSystemID=?").get(args.system_id) ?? null };
  if (pointer.subsystem === "sde_type") return { data: getDatabase().prepare("SELECT * FROM invTypes WHERE typeID=?").get(args.type_id) ?? null };
  if (pointer.subsystem === "esi_planetary_colonies" || pointer.subsystem === "esi_planetary_colony") {
    const char = await getActiveCharacter(Number(args.character_id));
    if (!char.scopes.split(" ").includes("esi-planets.manage_planets.v1")) throw new Error("Character requires esi-planets.manage_planets.v1");
    const endpoint = args.planet_id ? `/characters/${char.characterId}/planets/${args.planet_id}/` : `/characters/${char.characterId}/planets/`;
    return await esiGetWithMetadata(endpoint, { characterId: char.characterId, allowStale: true });
  }
  throw new Error("No source resolver registered");
}

export function registerEntityContextTools(server: McpServer): void {
  server.tool("get_entity_context", "Discover indexed durable records and logical Galaxy sources by stable entity ID. Sources stay separate and unresolved by default; resolve_live opts into bounded ESI calls with normal cache/auth rules. Legacy records require approved backfill. Compound entity_refs match all supplied identities within a record, not ownership.", {
    namespace: z.string().min(1).max(200).default("wormlife"), entity_type: entityType, entity_id: entityId,
    entity_refs: z.array(entityRef).max(20).default([]).describe("Additional IDs required on matching records"),
    include_records: z.boolean().default(true), include_esi: z.boolean().default(true), include_sde: z.boolean().default(true),
    relation_depth: z.number().int().min(0).max(1).default(1), current_only: z.boolean().default(true),
    limit: z.number().int().min(1).max(50).default(10), offset: z.number().int().min(0).max(1000000).default(0),
    resolve_live: z.boolean().default(false), resolve_sde: z.boolean().default(false),
    source_limit: z.number().int().min(1).max(10).default(5),
  }, async args => {
    const index = new EntityIndex(getStateDatabase());
    const refs = [{ type: args.entity_type, id: args.entity_id }, ...args.entity_refs];
    const related = args.relation_depth ? index.related({ ...args, entity_refs: refs, match: "all" }) : { related_records: [], nextOffset: null };
    const sources = new Map<string, SourcePointer>();
    const add = (items: SourcePointer[]) => {
      for (const source of items) {
        if ((source.source === "esi_live" && !args.include_esi) || (source.source === "sde_static" && !args.include_sde)) continue;
        const key = JSON.stringify([source.subsystem, source.arguments]);
        if (sources.size < args.source_limit) sources.set(key, source);
      }
    };
    add(discoverSources(refs, 50));
    if (args.relation_depth) for (const record of related.related_records) {
      const metadata = index.metadata(record.id);
      add([...explicitSources(metadata.related_galaxy), ...discoverSources(metadata.entity_refs, 50)]);
    }
    const resolved = [];
    for (const source of sources.values()) {
      if ((source.source === "esi_live" && args.resolve_live) || (source.source === "sde_static" && args.resolve_sde)) {
        try { resolved.push({ ...source, resolved: true, ...await resolveSource(source) }); }
        catch (error) { resolved.push({ ...source, error: error instanceof Error ? error.message : String(error) }); }
      } else resolved.push(source);
    }
    return jsonResult({ entity_refs: refs, ...(args.include_records ? related : {}), sources: resolved,
      source_discovery_scope: "Requested entities and this bounded page of matching records; availability does not assert authorization or colony ownership.",
      index_coverage: index.coverage(args.namespace) });
  });
}
