import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { EntityIndex, extractEntityRefs, type EntityRef } from "./entities.js";

type AuditedRecord = {
  id: string; kind: string; key: string | null; record_sha256: string; current: boolean;
  direct_refs: EntityRef[]; deterministic_name_refs: EntityRef[]; extraction_error?: string | null;
};
export type BackfillAudit = { namespace: string; manifest: AuditedRecord[] };
export type IdentityVerification = {
  namespace: string; manifest_sha256: string; all_verified: boolean; verified_at: string;
  checks: Array<{ type: string; id: string; verified: boolean; name: string; sde?: { name?: string } | null }>;
  conflicts: unknown[];
};
export function recordFingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ id: row.id, payload: row.payload, observed_at: row.observed_at,
    created_at: row.created_at, source_type: row.source_type, source_ref: row.source_ref, status: row.status,
    supersedes_id: row.supersedes_id, tags: row.tags })).digest("hex");
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown, message: string) => { if (sha(left) !== sha(right)) throw new Error(message); };

/** Append only approved side-table metadata. The caller must already have historical-backfill approval. */
export function applyEntityBackfill(db: Database.Database, auditBytes: Buffer, verification: IdentityVerification,
  expectedRecords: number, expectedSkips: number, saveBackup: (snapshot: unknown) => void) {
  const audit = JSON.parse(auditBytes.toString("utf8")) as BackfillAudit;
  if (!verification.all_verified || verification.conflicts.length || verification.namespace !== audit.namespace ||
    verification.manifest_sha256 !== createHash("sha256").update(auditBytes).digest("hex")) throw new Error("Identity verification does not cover this exact manifest");
  const age = Date.now() - Date.parse(verification.verified_at);
  if (!Number.isFinite(age) || age < -60000 || age > 86400000) throw new Error("Refresh ESI identity verification before applying this manifest");
  if (new Set(audit.manifest.map(entry => entry.id)).size !== audit.manifest.length) throw new Error("Duplicate manifest record IDs");
  const verified = new Map(verification.checks.filter(check => check.verified).map(check => [`${check.type}:${check.id}`, check]));
  const targets = audit.manifest.filter(entry => entry.direct_refs.length || entry.deterministic_name_refs.length);
  const skipped = audit.manifest.filter(entry => !entry.direct_refs.length && !entry.deterministic_name_refs.length);
  if (targets.length !== expectedRecords || skipped.length !== expectedSkips) throw new Error("Manifest differs from approved record/skip counts");
  const targetIds = new Set(targets.map(entry => entry.id));
  return db.transaction(() => {
    const index = new EntityIndex(db);
    const records = db.prepare("SELECT * FROM records ORDER BY id").all() as Array<Record<string, unknown>>;
    const previousRefs = db.prepare("SELECT * FROM record_entity_refs ORDER BY record_id,entity_type,entity_id").all() as Array<{ record_id: string }>;
    const previousMetadata = db.prepare("SELECT * FROM record_entity_metadata ORDER BY record_id").all() as Array<{ record_id: string }>;
    const rows = new Map(records.map(row => [row.id, row]));
    const currentIds = new Set((db.prepare("SELECT r.id FROM records r WHERE NOT EXISTS (SELECT 1 FROM records n WHERE n.supersedes_id=r.id)").all() as { id: string }[]).map(row => row.id));
    const plan = targets.map(entry => {
      const row = rows.get(entry.id);
      if (!row || row.namespace !== audit.namespace || row.kind !== entry.kind || row.key !== entry.key || recordFingerprint(row) !== entry.record_sha256)
        throw new Error(`Audited record changed or missing: ${entry.id}`);
      if (entry.extraction_error) throw new Error(`Extraction error in approved record: ${entry.id}`);
      const refs = extractEntityRefs({}, [...entry.direct_refs, ...entry.deterministic_name_refs].map(ref => {
        const evidence = verified.get(`${ref.type}:${ref.id}`);
        if (!evidence) throw new Error(`No successful ESI verification for ${ref.type}:${ref.id}`);
        return { type: ref.type, id: String(ref.id), name: evidence.sde?.name ?? evidence.name };
      }));
      const existing = index.metadata(entry.id);
      if (existing.entity_indexed || existing.entity_refs.length) {
        same(existing.entity_refs.map(({ type, id }) => `${type}:${id}`).sort(), refs.map(({ type, id }) => `${type}:${id}`).sort(), `Conflicting existing index: ${entry.id}`);
        if (!existing.entity_indexed) throw new Error(`Incomplete existing metadata: ${entry.id}`);
      }
      return { entry, refs, alreadyIndexed: existing.entity_indexed };
    });
    // Backup is durable before the first insert. A backup failure aborts the transaction.
    saveBackup({ captured_at: new Date().toISOString(), namespace: audit.namespace,
      records, record_entity_refs: previousRefs, record_entity_metadata: previousMetadata });
    let inserted = 0, insertedRefs = 0;
    for (const item of plan) {
      if (item.alreadyIndexed) continue;
      index.write(item.entry.id, item.refs, []);
      inserted++; insertedRefs += item.refs.length;
    }
    same(db.prepare("SELECT * FROM records ORDER BY id").all(), records, "Original record fields changed; rolling back");
    const finalRefs = db.prepare("SELECT * FROM record_entity_refs ORDER BY record_id,entity_type,entity_id").all() as Array<{ record_id: string }>;
    const finalMetadata = db.prepare("SELECT * FROM record_entity_metadata ORDER BY record_id").all() as Array<{ record_id: string }>;
    same(finalRefs.filter(row => !targetIds.has(row.record_id)), previousRefs.filter(row => !targetIds.has(row.record_id)), "Non-target references changed; rolling back");
    same(finalMetadata.filter(row => !targetIds.has(row.record_id)), previousMetadata.filter(row => !targetIds.has(row.record_id)), "Non-target metadata changed; rolling back");
    return { namespace: audit.namespace, inserted_records: inserted, inserted_refs: insertedRefs,
      already_indexed: plan.length - inserted, targeted_records: plan.length,
      targeted_current: plan.filter(item => currentIds.has(item.entry.id)).length,
      targeted_historical: plan.filter(item => !currentIds.has(item.entry.id)).length,
      lifecycle_changes_since_audit: plan.filter(item => currentIds.has(item.entry.id) !== item.entry.current).map(item => item.entry.id),
      skipped_ids: skipped.map(entry => entry.id), inserted_ids: plan.filter(item => !item.alreadyIndexed).map(item => item.entry.id),
      record_fields_unchanged: true, non_target_indexes_unchanged: true, records_sha256: sha(records),
      completed_at: new Date().toISOString() };
  }).immediate();
}
