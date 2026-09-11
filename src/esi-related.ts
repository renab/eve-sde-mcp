import { AsyncLocalStorage } from "node:async_hooks";
import { EntityIndex, entityFieldType, entityArrayFieldType, discriminatedEntityRefs, entityId, type EntityRef } from "./entities.js";
import { getStateDatabase } from "./persistence.js";

const MAX_REFS = 1000;
const MAX_VISITS = 20000;
const skip = new Set(["related_records", "related_record_context", "related_targets", "related_galaxy", "available_sources"]);
type ReadContext = { refs: Map<string, EntityRef>; truncated: boolean };
const activeRead = new AsyncLocalStorage<ReadContext>();
export function createEsiReadContext(): ReadContext { return { refs: new Map(), truncated: false }; }
export function withEsiReadContext<T>(context: ReadContext, callback: () => T): T { return activeRead.run(context, callback); }

function add(context: ReadContext, type: string, value: unknown) {
  const parsed = entityId.safeParse(value);
  if (!parsed.success) return;
  const key = `${type}:${parsed.data}`;
  if (context.refs.has(key)) return;
  if (context.refs.size >= MAX_REFS) { context.truncated = true; return; }
  context.refs.set(key, { type, id: parsed.data });
}

/** Request-scoped identity only. No credentials, response data, HTTP URLs, or cache mutations. */
export function observeEsiRead(esiPath: string): void {
  const context = activeRead.getStore();
  if (!context) return;
  const segments = esiPath.split("?")[0].split("/").filter(Boolean);
  const resources: Record<string, string> = { characters: "character", corporations: "corporation", alliances: "alliance",
    systems: "solar_system", planets: "planet", structures: "structure", stations: "station", types: "type",
    regions: "region", constellations: "constellation" };
  for (let i = 0; i < segments.length - 1; i++) {
    const type = resources[segments[i]];
    if (type) add(context, type, segments[i + 1]);
  }
  if (segments[0] === "markets") add(context, "region", segments[1]);
  if (segments[0] === "loyalty" && segments[1] === "stores") add(context, "corporation", segments[2]);
  if (segments[0] === "route") { add(context, "solar_system", segments[1]); add(context, "solar_system", segments[2]); }
}

export function observeReadCharacter(characterId: number): void {
  const context = activeRead.getStore();
  if (context) add(context, "character", characterId);
}

/** Inspect final, filtered/paged output, not raw upstream collections. Never infer bare IDs or names. */
export function collectResponseEntities(value: unknown): ReadContext {
  const context = createEsiReadContext();
  let visited = 0;
  const walk = (next: unknown, depth: number): void => {
    if (++visited > MAX_VISITS || depth > 32) { context.truncated = true; return; }
    if (!next || typeof next !== "object") return;
    if (!Array.isArray(next)) for (const ref of discriminatedEntityRefs(next as Record<string, unknown>)) add(context, ref.type, ref.id);
    // Visit each child immediately so broad arrays retain the first returned rows.
    for (const key in next) {
      if (++visited > MAX_VISITS) { context.truncated = true; break; }
      if (skip.has(key)) continue;
      const child = (next as Record<string, unknown>)[key];
      const type = entityFieldType(key);
      if (type) add(context, type, child);
      const arrayType = entityArrayFieldType(key);
      if (arrayType && Array.isArray(child)) {
        for (const item of child) {
          if (++visited > MAX_VISITS) { context.truncated = true; break; }
          add(context, arrayType, item);
        }
      }
      if (child && typeof child === "object") walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return context;
}

type DiscoveryOptions = { include_related?: boolean; record_namespace?: string; related_limit?: number };
export function enrichRelatedToolResult(result: any, args: DiscoveryOptions & Record<string, unknown>, request: ReadContext): any {
  if (args.include_related === false || result?.isError || !Array.isArray(result?.content)) return result;
  const parsed: Array<{ index: number; value: unknown }> = [];
  for (let i = 0; i < result.content.length; i++) {
    const part = result.content[i];
    if (part.type !== "text") continue;
    try { parsed.push({ index: i, value: JSON.parse(part.text) }); } catch { /* Preserve human-readable errors and non-JSON content. */ }
  }
  if (!parsed.length) return result;
  const output = collectResponseEntities(parsed.map(part => part.value));
  const argumentsContext = collectResponseEntities(args);
  for (const ref of argumentsContext.refs.values()) add(request, ref.type, ref.id);
  request.truncated ||= argumentsContext.truncated;
  const namespace = args.record_namespace ?? "wormlife", limit = args.related_limit ?? 10;
  let annotation: Record<string, unknown>;
  try {
    const index = new EntityIndex(getStateDatabase());
    // Returned entities take precedence over broader character/request context.
    const specific = output.refs.size ? index.related({ namespace, entity_refs: [...output.refs.values()], limit }) : { related_records: [], nextOffset: null };
    const contextual = request.refs.size ? index.related({ namespace, entity_refs: [...request.refs.values()], limit }) : { related_records: [], nextOffset: null };
    const records = [...new Map([...specific.related_records, ...contextual.related_records].map(record => [record.id, record])).values()];
    const selected = records.slice(0, limit).map(record => {
      const matches = index.metadata(record.id).entity_refs.filter(ref => output.refs.has(`${ref.type}:${ref.id}`) || request.refs.has(`${ref.type}:${ref.id}`));
      return { ...record, matched_entity_refs: matches.slice(0, 10), matched_entity_refs_truncated: matches.length > 10,
        match_scope: specific.related_records.some(r => r.id === record.id) ? "response_entity" : "request_context" };
    });
    annotation = { related_records: selected, related_record_context: { status: "ok", namespace, current_only: true,
      limit, has_more: records.length > limit || specific.nextOffset !== null || contextual.nextOffset !== null,
      response_entity_count: output.refs.size, request_entity_count: request.refs.size,
      entity_scan_truncated: output.truncated || request.truncated,
      continuation: "Use get_entity_context with a matched entity type/id to page further records. Request context means co-reference, not ownership." } };
  } catch {
    // Discovery must not turn a successful ESI lookup into a failure or a false empty result.
    annotation = { related_record_context: { status: "unavailable", namespace, reason: "Related-record index unavailable; primary response preserved." } };
  }
  const content = [...result.content];
  const first = parsed[0];
  if (first.value && typeof first.value === "object" && !Array.isArray(first.value)) {
    const object = first.value as Record<string, unknown>;
    // Keep existing PI/structure pointer contracts and pagination. The summary still supplies scan status.
    if (Array.isArray(object.related_records) && Array.isArray(annotation.related_records)) {
      const existing = new Set(object.related_records.map(record => record.id));
      annotation.related_record_context = { ...(annotation.related_record_context as object),
        additional_related_records: annotation.related_records.filter(record => !existing.has(record.id)) };
    }
    const merged = { ...object, ...annotation, ...(object.related_records !== undefined ? { related_records: object.related_records } : {}) };
    content[first.index] = { ...content[first.index], text: JSON.stringify(merged, null, 2) };
    return { ...result, content, ...(result.structuredContent ? { structuredContent: merged } : {}) };
  }
  // Arrays/scalars keep their original first content block and shape.
  content.push({ type: "text", text: JSON.stringify(annotation, null, 2) });
  return { ...result, content };
}
