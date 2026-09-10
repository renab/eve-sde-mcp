import { z } from "zod";
import type Database from "better-sqlite3";

const label = z.string().trim().min(1).max(200);
export const entityType = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// Decimal strings preserve ESI's potentially large location/structure identifiers.
export const entityId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]{0,19}$/)])
  .transform(String);
export const entityRef = z.object({ type: entityType, id: entityId, name: label.optional() });
export type EntityRef = z.infer<typeof entityRef>;
export const galaxyRelation = z.union([
  z.object({ relation: label, subsystem: entityType, entity_refs: z.array(entityRef).min(1).max(20) }),
  z.object({ relation: label, namespace: label, kind: label.optional(), entity_refs: z.array(entityRef).min(1).max(20) }),
]);
export const relationshipInputShape = {
  entity_refs: z.array(entityRef).max(1000).default([]),
  related_galaxy: z.array(galaxyRelation).max(100).default([]),
};
export const discoveryShape = {
  include_related: z.boolean().default(false),
  include_live_sources: z.boolean().default(true),
  relation_depth: z.number().int().min(0).max(1).default(1),
  related_limit: z.number().int().min(1).max(50).default(10),
};
export const endpointDiscoveryShape = {
  include_related: z.boolean().default(true).describe("Advertise matching current durable records; does not fetch extra ESI data"),
  record_namespace: label.default("wormlife"),
  related_limit: z.number().int().min(1).max(50).default(10),
};

const fields = new Map<string, string>();
for (const type of ["character", "solar_system", "planet", "structure", "corporation", "location", "type", "station", "region", "constellation", "alliance"]) {
  const camel = type.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  for (const field of [`${type}_id`, `${camel}Id`, `${camel}ID`]) fields.set(field, type);
}

/** Only explicitly typed ID fields are promoted. Bare id, owner_id and names are ambiguous. */
export function extractEntityRefs(payload: unknown, explicit: EntityRef[] = []): EntityRef[] {
  const refs = new Map<string, EntityRef>();
  const add = (ref: EntityRef) => {
    const key = `${ref.type}:${ref.id}`;
    if (!refs.has(key)) refs.set(key, ref);
  };
  for (const ref of explicit) add(entityRef.parse(ref));
  const walk = (value: unknown, depth: number) => {
    if (depth > 32 || !value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const type = fields.get(key) ?? [...fields].find(([field]) => field.endsWith("_id") && key.endsWith(`_${field}`))?.[1];
      if (type) {
        const parsed = entityId.safeParse(child);
        if (parsed.success) add({ type, id: parsed.data });
      }
      if (child && typeof child === "object") walk(child, depth + 1);
    }
  };
  walk(payload, 0);
  if (refs.size > 1000) throw new Error("Record exceeds 1000 normalized entity references");
  return [...refs.values()];
}

export type SourcePointer = {
  relation: string; subsystem: string; source: "esi_live" | "sde_static";
  entity_refs: EntityRef[]; tool: string; arguments: Record<string, unknown>; resolved: false;
};
export function explicitSources(relations: z.infer<typeof galaxyRelation>[]): SourcePointer[] {
  return relations.flatMap(relation => "subsystem" in relation
    ? discoverSources(relation.entity_refs, 50).filter(source => source.subsystem === relation.subsystem)
      .map(source => ({ ...source, relation: relation.relation })) : []);
}
export function discoverSources(refs: EntityRef[], limit = 10): SourcePointer[] {
  const result: SourcePointer[] = [];
  for (const ref of refs) {
    if (result.length >= limit) break;
    if (ref.type === "structure") {
      result.push({ relation: "current_state_for", subsystem: "esi_structure", source: "esi_live", entity_refs: [ref],
        tool: "get_structure", arguments: { structure_id: ref.id }, resolved: false });
      continue;
    }
    const mapping: Record<string, [string, string, string, "esi_live" | "sde_static"]> = {
      character: ["esi_planetary_colonies", "get_planetary_colonies", "character_id", "esi_live"],
      solar_system: ["sde_system", "get_system", "system_id", "sde_static"],
      type: ["sde_type", "get_type", "type_id", "sde_static"],
    };
    const target = mapping[ref.type];
    if (target && Number.isSafeInteger(Number(ref.id))) result.push({ relation: "current_state_for", subsystem: target[0],
      source: target[3], entity_refs: [ref], tool: target[1], arguments: { [target[2]]: Number(ref.id) }, resolved: false });
  }
  // A flat multi-entity record cannot establish ownership pairs. Do not cross-product them.
  const characters = refs.filter(r => r.type === "character"), planets = refs.filter(r => r.type === "planet");
  if (characters.length === 1 && planets.length === 1 && Number.isSafeInteger(Number(characters[0].id)) && Number.isSafeInteger(Number(planets[0].id))) {
    result.unshift({ relation: "current_state_for", subsystem: "esi_planetary_colony", source: "esi_live",
      entity_refs: [characters[0], planets[0]], tool: "get_planetary_colony",
      arguments: { character_id: Number(characters[0].id), planet_id: Number(planets[0].id) }, resolved: false });
  }
  return result.slice(0, limit);
}

export class EntityIndex {
  constructor(readonly db: Database.Database) {}
  write(recordId: string, refs: EntityRef[], relationships: z.infer<typeof galaxyRelation>[]) {
    const insert = this.db.prepare("INSERT INTO record_entity_refs VALUES (?,?,?,?)");
    for (const ref of refs) insert.run(recordId, ref.type, ref.id, ref.name ?? null);
    this.db.prepare("INSERT INTO record_entity_metadata VALUES (?,?)").run(recordId, JSON.stringify(relationships));
  }
  metadata(recordId: string) {
    const refs = this.db.prepare("SELECT entity_type type,entity_id id,name FROM record_entity_refs WHERE record_id=? ORDER BY entity_type,entity_id").all(recordId) as EntityRef[];
    const row = this.db.prepare("SELECT related_galaxy FROM record_entity_metadata WHERE record_id=?").get(recordId) as { related_galaxy: string } | undefined;
    return { entity_refs: refs.map(ref => ref.name === null ? { type: ref.type, id: ref.id } : ref),
      related_galaxy: row ? JSON.parse(row.related_galaxy) as z.infer<typeof galaxyRelation>[] : [], entity_indexed: !!row };
  }
  coverage(namespace: string) {
    return this.db.prepare(`SELECT count(*) total_records,
      sum(CASE WHEN m.record_id IS NULL THEN 1 ELSE 0 END) unindexed_records
      FROM records r LEFT JOIN record_entity_metadata m ON m.record_id=r.id WHERE r.namespace=?`).get(namespace) as { total_records: number; unindexed_records: number | null };
  }
  related(input: { namespace: string; entity_refs: EntityRef[]; current_only?: boolean; limit?: number; offset?: number; exclude_id?: string; match?: "any" | "all"; kind?: string }) {
    const namespace = label.parse(input.namespace), refs = z.array(entityRef).min(1).max(1000).parse(input.entity_refs);
    const limit = z.number().int().min(1).max(50).parse(input.limit ?? 10);
    const offset = z.number().int().min(0).max(1000000).parse(input.offset ?? 0);
    const unique = [...new Map(refs.map(ref => [`${ref.type}:${ref.id}`, ref])).values()];
    const args: unknown[] = [namespace, JSON.stringify(unique), input.match === "all" ? unique.length : 1];
    const clauses = ["r.namespace=?", `r.id IN (SELECT e.record_id FROM json_each(?) q
      JOIN record_entity_refs e ON e.entity_type=json_extract(q.value,'$.type') AND e.entity_id=json_extract(q.value,'$.id')
      GROUP BY e.record_id HAVING count(*)>=?)`];
    if (input.current_only !== false) clauses.push("NOT EXISTS (SELECT 1 FROM records n WHERE n.supersedes_id=r.id)");
    if (input.exclude_id) { clauses.push("r.id<>?"); args.push(input.exclude_id); }
    if (input.kind) { clauses.push("r.kind=?"); args.push(input.kind); }
    const rows = this.db.prepare(`SELECT r.id,r.namespace,r.kind,r.key,r.observed_at,r.created_at,r.source_type,r.source_ref,r.status,r.supersedes_id,
      NOT EXISTS (SELECT 1 FROM records n WHERE n.supersedes_id=r.id) is_current
      FROM records r WHERE ${clauses.join(" AND ")} ORDER BY is_current DESC,r.observed_at DESC,r.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset) as any[];
    return { related_records: rows.slice(0, limit).map(row => ({ ...row, is_current: !!row.is_current, source: "wormlife_record",
      relation: unique.length === 1 ? `same_${unique[0].type}` : "same_entity" })),
      nextOffset: rows.length > limit ? offset + limit : null };
  }
}
