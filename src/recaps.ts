import { createHash } from "crypto";
import { Ledger, type LedgerRecord } from "./ledger.js";

export const GENERATED_START = "<!-- GALAXY:GENERATED:START -->";
export const GENERATED_END = "<!-- GALAXY:GENERATED:END -->";
function safe(value: unknown): string {
  return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/[`*_[\]#|\\]/g,"\\$&").replace(/[\r\n]/g," ");
}
export function replaceGenerated(existing: string, generated: string): string {
  const count = (token: string) => existing.split(token).length - 1;
  if (!count(GENERATED_START) && !count(GENERATED_END)) return existing + (existing.endsWith("\n") ? "\n" : "\n\n") + generated + "\n";
  if (count(GENERATED_START) !== 1 || count(GENERATED_END) !== 1 || existing.indexOf(GENERATED_END) < existing.indexOf(GENERATED_START)) throw new Error("Malformed or duplicate Galaxy markers; refusing to replace human content");
  return existing.slice(0,existing.indexOf(GENERATED_START)) + generated + existing.slice(existing.indexOf(GENERATED_END) + GENERATED_END.length);
}
export function renderRecap(ledger: Ledger, input: {
  namespace: string; mode: "run" | "daily" | "trial"; id?: string; date?: string; timezone?: string;
  include_related?: boolean;
  observed_from?: string; observed_to?: string; vaultId: string; filepath: string; existing_markdown?: string;
}) {
  if (!input.filepath.endsWith(".md") || /(^|[\\/])\.\.([\\/]|$)|^[\\/]|:/.test(input.filepath)) throw new Error("filepath must be a relative Markdown path without traversal");
  const zone = input.timezone ?? "UTC";
  const format = new Intl.DateTimeFormat("en-CA", {timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"});
  let records: LedgerRecord[];
  if (input.mode === "run") {
    if (!input.id) throw new Error("run recap requires a record id");
    const history = ledger.history({namespace:input.namespace,id:input.id});
    records = history.length ? [history[history.length-1]!] : [];
    if (!records.length) throw new Error("Run record not found in namespace");
    if (input.include_related !== false) {
      const keys = [...new Set([...history.map(r=>r!.id), ...records.flatMap(r=>r.key ? [r.key] : [])])];
      const placeholders = keys.map(()=>"?").join(",");
      const links = ledger.db.prepare(`SELECT from_key,to_key FROM relationships WHERE namespace=? AND (from_key IN (${placeholders}) OR to_key IN (${placeholders})) LIMIT 201`).all(input.namespace,...keys,...keys) as {from_key:string;to_key:string}[];
      if (links.length > 200) throw new Error("Run recap has over 200 relationships; narrow the selection or disable include_related");
      const related = [...new Set(links.flatMap(link=>[link.from_key,link.to_key]).filter(key=>!keys.includes(key)))];
      for (const key of related) {
        const byId = ledger.history({namespace:input.namespace,id:key});
        if (byId.length) records.push(byId[byId.length-1]!);
        else {
          const matches = ledger.search({namespace:input.namespace,key,limit:200});
          if (matches.nextOffset !== null) throw new Error("Related key has more than 200 records; use unambiguous record IDs");
          records.push(...matches.records);
        }
      }
      records = [...new Map(records.map(r=>[r.id,r])).values()];
    }
  } else {
    if (input.mode === "daily" && (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(Date.parse(input.date)))) throw new Error("daily recap requires YYYY-MM-DD date");
    let from = input.observed_from, to = input.observed_to;
    if (input.mode === "daily") {
      from = new Date(Date.parse(input.date!) - 86400000).toISOString();
      to = new Date(Date.parse(input.date!) + 2 * 86400000).toISOString();
    }
    const first = ledger.search({namespace:input.namespace,observed_from:from,observed_to:to,limit:200});
    if (first.total > 5000) throw new Error("Recap selection exceeds 5000 records; narrow the date range");
    records = first.records;
    for (let offset=200; offset < first.total; offset+=200) records.push(...ledger.search({namespace:input.namespace,observed_from:from,observed_to:to,offset,limit:200}).records);
    if (input.mode === "daily") records = records.filter(r => r.observed_at && format.format(new Date(r.observed_at)) === input.date);
  }
  // Sum only explicit quantities, grouped by provenance and field; never blend
  // wallet facts, user reports and estimates or invent market prices/profit.
  const totals = new Map<string,number>();
  for (const r of records) {
    const source = r.source_type ?? "unspecified source";
    if (r.payload.harvest && typeof r.payload.harvest === "object" && !Array.isArray(r.payload.harvest)) {
      for (const [type,quantity] of Object.entries(r.payload.harvest)) if (typeof quantity === "number" && Number.isFinite(quantity)) {
        const key = `${source} / harvest.${type}`; totals.set(key,(totals.get(key) ?? 0)+quantity);
      }
    }
    for (const field of ["income_isk","expense_isk","sale_isk","estimated_value_isk"] as const) {
      const value = r.payload[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        const key = `${source} / ${field}`; totals.set(key,(totals.get(key) ?? 0)+value);
      }
    }
  }
  const lines = [GENERATED_START, "## Galaxy record projection", `${records.length} current record(s). Structured facts and provenance are owned by Galaxy.`,
    "Missing values are unknown, not zero. Interim and final observations retain their recorded status. These totals are sums of selected records, not a reconciled wallet balance or profit."];
  if (input.mode === "daily") lines.push(`Day: ${safe(input.date)} (${safe(zone)}); records without observed_at are excluded.`);
  if (totals.size) lines.push("", "## Calculated totals (explicit fields only)", ...[...totals].map(([key,value])=>`- ${safe(key)}: ${value.toLocaleString("en-US",{maximumFractionDigits:8})}`));
  for (const r of records) {
    lines.push("",`### ${safe(r.kind)} — ${safe(r.key ?? r.id)}`,
      `- Record: ${safe(r.id)}; status: ${safe(r.status ?? "unspecified")}`,
      `- Observed: ${safe(r.observed_at ?? "unknown")}; recorded: ${safe(r.created_at)}`,
      `- Source: ${safe(r.source_type ?? "unspecified")}; reference: ${safe(r.source_ref ?? "not supplied")}`,
      `- Supersedes: ${safe(r.supersedes_id ?? "none")}`, "", "Payload (recorded values):");
    const walk = (value: unknown, path: string) => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [key,v] of Object.entries(value)) walk(v,path ? `${path}.${key}` : key);
      } else lines.push(`- ${safe(path)}: ${safe(typeof value === "string" ? value : JSON.stringify(value))}`);
    };
    walk(r.payload,"");
  }
  lines.push("", GENERATED_END);
  const generated = lines.join("\n");
  const existing = input.existing_markdown ?? `# ${safe(input.date ?? input.namespace)} — ${safe(input.mode)} recap\n\n## Human Notes\n`;
  const markdown = replaceGenerated(existing,generated);
  return { vaultId:input.vaultId,filepath:input.filepath,markdown,recordIds:records.map(r=>r.id),
    publicationRequired:true, existingContentHash: input.existing_markdown === undefined ? null : createHash("sha256").update(existing).digest("hex"),
    publishingNote:"Galaxy does not write Obsidian. Read the latest note, pass it as existing_markdown, and publish only if it has not changed meanwhile. Do not overwrite annotations with an outdated projection." };
}
