import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { EntityIndex, extractEntityRefs, relationshipInputShape, discoveryShape, discoverSources, explicitSources, type EntityRef } from "./entities.js";

const label = z.string().trim().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const recordShape = {
  ...relationshipInputShape,
  namespace: label, kind: label, key: label.optional(), observed_at: timestamp.optional(),
  source_type: label.optional(), source_ref: z.string().max(4000).optional(), status: label.optional(),
  tags: z.array(label).max(100).default([]), payload: z.record(z.string(), z.unknown()),
};
export const recordInput = z.object(recordShape);
export const selectorShape = { namespace: label, id: label.optional(), kind: label.optional(), key: label.optional() };
const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
export const filterSchema = z.object({
  path: z.string().regex(/^\$\.payload(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+$/).max(500),
  op: z.enum(["=", "!=", "<", "<=", ">", ">=", "contains", "exists", "in"]),
  value: z.union([scalar, z.array(scalar).max(100)]).optional(),
});
export const searchShape = {
  ...discoveryShape,
  namespace: label, kind: label.optional(), key: label.optional(), tags: z.array(label).max(100).default([]),
  observed_from: timestamp.optional(), observed_to: timestamp.optional(), current_only: z.boolean().default(true),
  filters: z.array(filterSchema).max(20).default([]), text: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).max(1000000).default(0),
};
export type LedgerRecord = {
  id: string; namespace: string; kind: string; key: string | null; observed_at: string | null;
  created_at: string; source_type: string | null; source_ref: string | null; supersedes_id: string | null;
  status: string | null; tags: string[]; payload: Record<string, unknown>;
  entity_refs?: EntityRef[];
};
function json(value: unknown): string {
  const walk = (v: unknown, depth: number): void => {
    if (depth > 32) throw new Error("JSON nesting exceeds 32 levels");
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
    if (typeof v !== "object") throw new Error("Payload must contain only JSON values");
    for (const entry of Object.values(v)) walk(entry, depth + 1);
  };
  walk(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 262144) throw new Error("JSON exceeds 256 KiB");
  return text;
}
function decode(row: any): LedgerRecord | null {
  return row ? { ...row, tags: JSON.parse(row.tags), payload: JSON.parse(row.payload) } : null;
}
const current = "NOT EXISTS (SELECT 1 FROM records newer WHERE newer.supersedes_id = r.id)";

export class Ledger {
  constructor(public db: Database.Database) {}
  decorate(record: LedgerRecord | null): LedgerRecord | null {
    return record ? { ...record, ...new EntityIndex(this.db).metadata(record.id) } : null;
  }
  discover(record: LedgerRecord, input: unknown) {
    const options = z.object(discoveryShape).parse(input);
    if (!options.include_related || options.relation_depth === 0) return record;
    const index = new EntityIndex(this.db), metadata = index.metadata(record.id);
    const related = metadata.entity_refs.length ? index.related({ namespace: record.namespace, entity_refs: metadata.entity_refs,
      limit: options.related_limit, exclude_id: record.id }) : { related_records: [], nextOffset: null };
    const typed = [];
    // Typed targets are independently bounded; never recurse through returned records.
    for (const relation of metadata.related_galaxy.slice(0, options.related_limit)) {
      if (!("namespace" in relation)) continue;
      // Discovery is namespace scoped; cross-namespace pointers remain visible but unresolved.
      if (relation.namespace !== record.namespace) continue;
      typed.push({ ...relation, ...index.related({ namespace: record.namespace, kind: relation.kind,
        entity_refs: relation.entity_refs, match: "all", exclude_id: record.id, limit: 1 }) });
    }
    const sources = [...explicitSources(metadata.related_galaxy), ...discoverSources(metadata.entity_refs, options.related_limit)];
    const uniqueSources = [...new Map(sources.map(source => [JSON.stringify([source.subsystem, source.arguments]), source])).values()].slice(0, options.related_limit);
    return { ...record, ...related, related_targets: typed,
      ...(options.include_live_sources ? { available_sources: uniqueSources } : {}) };
  }
  get(input: unknown): LedgerRecord | null {
    const s = z.object(selectorShape).parse(input);
    if (s.id) return this.decorate(decode(this.db.prepare("SELECT * FROM records WHERE namespace = ? AND id = ?").get(s.namespace, s.id)));
    if (!s.kind || !s.key) throw new Error("Provide id, or kind and key");
    return this.decorate(decode(this.db.prepare(`SELECT r.* FROM records r WHERE namespace = ? AND kind = ? AND key = ? AND ${current}`).get(s.namespace, s.kind, s.key)));
  }
  store(input: unknown, supersedesId?: string): LedgerRecord {
    const r = recordInput.parse(input);
    const payload = json(r.payload);
    const refs = extractEntityRefs(r.payload, r.entity_refs);
    json(r.related_galaxy);
    return this.db.transaction(() => {
      if (supersedesId) {
        const previous = this.get({ namespace: r.namespace, id: supersedesId });
        if (!previous || previous.kind !== r.kind || previous.key !== (r.key ?? null)) throw new Error("Supersession must preserve namespace/kind/key of an existing record");
        if (this.db.prepare("SELECT 1 FROM records WHERE supersedes_id = ?").get(supersedesId)) throw new Error("Record has already been superseded; correct the current record instead");
      } else if (r.key && this.get({ namespace: r.namespace, kind: r.kind, key: r.key })) {
        throw new Error("Key already exists; use supersede_record to preserve correction history");
      }
      const value: LedgerRecord = { ...r, id: randomUUID(), key: r.key ?? null, observed_at: r.observed_at ?? null,
        created_at: new Date().toISOString(), source_type: r.source_type ?? null, source_ref: r.source_ref ?? null,
        status: r.status ?? null, supersedes_id: supersedesId ?? null };
      this.db.prepare(`INSERT INTO records VALUES (@id,@namespace,@kind,@key,@observed_at,@created_at,@source_type,@source_ref,@supersedes_id,@status,@tags,@payload)`)
        .run({ ...value, tags: JSON.stringify(value.tags), payload });
      this.db.prepare("INSERT INTO records_fts (id,text) VALUES (?,?)").run(value.id, JSON.stringify(value));
      new EntityIndex(this.db).write(value.id, refs, r.related_galaxy);
      return this.decorate(value)!;
    }).immediate();
  }
  history(input: unknown) {
    const selected = this.get(input);
    if (!selected) return [];
    // Follow only the explicit provenance chain, including unkeyed records.
    const rows = this.db.prepare(`WITH RECURSIVE ancestors(id,supersedes_id) AS (
      SELECT id,supersedes_id FROM records WHERE id = ?
      UNION ALL SELECT r.id,r.supersedes_id FROM records r JOIN ancestors a ON r.id=a.supersedes_id
    ), descendants(id) AS (
      SELECT id FROM ancestors WHERE supersedes_id IS NULL
      UNION ALL SELECT r.id FROM records r JOIN descendants d ON r.supersedes_id=d.id
    ) SELECT r.* FROM records r JOIN descendants d ON r.id=d.id ORDER BY r.rowid`).all(selected.id);
    return rows.map(row => this.decorate(decode(row)));
  }
  search(input: unknown) {
    const s = z.object(searchShape).parse(input);
    if (s.observed_from && s.observed_to && s.observed_from >= s.observed_to) throw new Error("observed_to must be after observed_from (exclusive upper bound)");
    const start = performance.now();
    const clauses = ["r.namespace = ?"];
    const args: any[] = [s.namespace];
    for (const name of ["kind", "key"] as const) if (s[name]) { clauses.push(`r.${name} = ?`); args.push(s[name]); }
    if (s.current_only) clauses.push(current);
    if (s.observed_from) { clauses.push("r.observed_at >= ?"); args.push(s.observed_from); }
    if (s.observed_to) { clauses.push("r.observed_at < ?"); args.push(s.observed_to); }
    for (const tag of s.tags) { clauses.push("EXISTS (SELECT 1 FROM json_each(r.tags) WHERE value = ?)"); args.push(tag); }
    for (const f of s.filters) {
      const p = f.path.replace(/^\$\.payload/, "$");
      const value = (v: unknown) => typeof v === "boolean" ? Number(v) : v;
      if (f.op === "exists") { clauses.push(`json_type(r.payload, ?) IS ${f.value === false ? "" : "NOT "}NULL`); args.push(p); }
      else if (f.op === "in") {
        if (!Array.isArray(f.value) || !f.value.length) throw new Error("in requires a nonempty scalar array");
        clauses.push(`json_extract(r.payload, ?) IN (${f.value.map(() => "?").join(",")})`); args.push(p, ...f.value.map(value));
      } else if (f.op === "contains") {
        if (f.value === undefined || Array.isArray(f.value)) throw new Error("contains requires a scalar value");
        clauses.push("((json_type(r.payload, ?) = 'text' AND instr(json_extract(r.payload, ?), ?) > 0) OR (json_type(r.payload, ?) = 'array' AND EXISTS (SELECT 1 FROM json_each(r.payload, ?) WHERE value IS ?)))");
        args.push(p, p, value(f.value), p, p, value(f.value));
      } else {
        if (f.value === undefined || Array.isArray(f.value)) throw new Error("Comparison requires a scalar value");
        if (f.value === null && !["=", "!="].includes(f.op)) throw new Error("null supports only = or !=");
        if (typeof f.value === "number") { clauses.push("json_type(r.payload, ?) IN ('integer','real')"); args.push(p); }
        if (typeof f.value === "string") { clauses.push("json_type(r.payload, ?) = 'text'"); args.push(p); }
        if (typeof f.value === "boolean") { clauses.push("json_type(r.payload, ?) IN ('true','false')"); args.push(p); }
        // op comes only from the closed enum above; paths and values are parameters.
        clauses.push(`json_extract(r.payload, ?) ${f.value === null ? f.op === "=" ? "IS" : "IS NOT" : f.op} ?`);
        args.push(p, value(f.value));
      }
    }
    if (s.text) {
      const stop = new Set(["a", "an", "the", "where", "while", "and", "or", "in", "of", "to"]);
      const tokens = (s.text.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(t => !stop.has(t.toLowerCase())).slice(0, 40);
      if (!tokens.length) throw new Error("Text search needs at least one searchable word");
      // Quoted OR terms allow natural wording; this is lexical retrieval, not semantic AI search.
      clauses.push("r.id IN (SELECT id FROM records_fts WHERE records_fts MATCH ?)");
      args.push(tokens.map(t => `"${t}"`).join(" OR "));
    }
    const where = clauses.join(" AND ");
    const total = (this.db.prepare(`SELECT count(*) AS n FROM records r WHERE ${where}`).get(...args) as { n: number }).n;
    const records = this.db.prepare(`SELECT r.* FROM records r WHERE ${where} ORDER BY r.observed_at DESC,r.rowid DESC LIMIT ? OFFSET ?`).all(...args, s.limit, s.offset).map(decode);
    if (s.kind) this.db.prepare(`INSERT INTO query_usage VALUES (?,?,1,?) ON CONFLICT(namespace,kind) DO UPDATE SET count=count+1,elapsed_ms=elapsed_ms+excluded.elapsed_ms`).run(s.namespace,s.kind,performance.now()-start);
    return { records: (records as LedgerRecord[]).map(record => this.discover(this.decorate(record)!, s)), total, nextOffset: s.offset + records.length < total ? s.offset + records.length : null };
  }
  link(input: unknown) {
    const r = z.object({ namespace: label, from_key: label, relation: label, to_key: label, observed_at: timestamp.optional(), payload: z.record(z.string(),z.unknown()).default({}) }).parse(input);
    const result = { ...r, id: randomUUID(), created_at: new Date().toISOString(), observed_at: r.observed_at ?? null };
    this.db.prepare("INSERT INTO relationships VALUES (@id,@namespace,@from_key,@relation,@to_key,@observed_at,@created_at,@payload)").run({ ...result, payload: json(r.payload) });
    return result;
  }
  relationships(input: unknown) {
    const s = z.object({ namespace: label, from_key: label.optional(), to_key: label.optional(), relation: label.optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }).parse(input);
    const clauses = ["namespace = ?"], args: any[] = [s.namespace];
    for (const key of ["from_key", "to_key", "relation"] as const) if (s[key]) { clauses.push(`${key} = ?`); args.push(s[key]); }
    const rows = this.db.prepare(`SELECT * FROM relationships WHERE ${clauses.join(" AND ")} ORDER BY rowid LIMIT ? OFFSET ?`).all(...args, s.limit + 1,s.offset) as any[];
    return { relationships: rows.slice(0,s.limit).map(r => ({ ...r, payload: JSON.parse(r.payload) })), nextOffset: rows.length > s.limit ? s.offset + s.limit : null };
  }
  describe(namespace: string, kind: string) {
    const count = (this.db.prepare(`SELECT count(*) n FROM records r WHERE namespace=? AND kind=? AND ${current}`).get(namespace,kind) as {n:number}).n;
    const rows = this.db.prepare(`SELECT r.* FROM records r WHERE namespace=? AND kind=? AND ${current} ORDER BY rowid DESC LIMIT 5000`).all(namespace,kind).map(decode) as LedgerRecord[];
    const stats = new Map<string,{ presence: number; types: Set<string> }>();
    for (const r of rows) {
      const walk = (v: unknown, path: string) => {
        const type = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
        const field = stats.get(path) ?? { presence: 0, types: new Set<string>() };
        field.presence++; field.types.add(type); stats.set(path,field);
        if (type === "object") for (const [key,value] of Object.entries(v as object)) walk(value, `${path}.${key}`);
      };
      for (const [key,value] of Object.entries(r.payload)) walk(value,`payload.${key}`);
    }
    const fields = [...stats].map(([path,s]) => ({ path, types: [...s.types], presence: s.presence, presencePercent: rows.length ? s.presence / rows.length * 100 : 0 }));
    const observations = this.db.prepare(`SELECT min(observed_at) firstObservedAt,max(observed_at) lastObservedAt FROM records r WHERE namespace=? AND kind=? AND ${current}`).get(namespace,kind);
    const usage = this.db.prepare("SELECT count,elapsed_ms FROM query_usage WHERE namespace=? AND kind=?").get(namespace,kind) as {count:number;elapsed_ms:number} | undefined;
    const stableFields = fields.filter(f => f.presencePercent >= 90 && f.types.length === 1).map(f=>f.path);
    return { namespace,kind,recordCount:count,sampledCount:rows.length,currentOnly:true,fields,...observations as object,
      queryUsage: usage ?? {count:0,elapsed_ms:0}, promotion: {
        candidate: count >= 30 && stableFields.length > 0 && (usage?.count ?? 0) >= 10,
        stableFields, requiresHumanReview:true, automaticMigration:false,
        reason:"Heuristic: >=30 current records, >=90% presence with one type, >=10 kind-scoped searches. Semantic stability requires human review. Prefer a view before a materialized projection; preserve source records.",
      } };
  }
}
