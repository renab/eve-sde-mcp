import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStateDatabase } from "../persistence.js";
import { Ledger, recordShape, selectorShape, searchShape } from "../ledger.js";
import { renderRecap } from "../recaps.js";
import { jsonResult } from "../utils.js";
import { discoveryShape } from "../entities.js";

export function registerPersistenceTools(server: McpServer): void {
  const ledger = () => new Ledger(getStateDatabase());
  server.tool("store_record", "Append a structured fact with provenance. Kinds/payload fields are open-ended JSON. Existing keys require explicit supersession; never silently overwrite facts.", recordShape, async args=>jsonResult(ledger().store(args)));
  server.tool("get_record", "Get an exact record by namespace/id, or current namespace/kind/key. Historical ids stay historical. include_related discovers current entity matches and unresolved Galaxy sources.", { ...selectorShape, ...discoveryShape }, async args=>{
    const store = ledger(), record = store.get(args);
    return jsonResult({record: record ? store.discover(record, args) : null});
  });
  server.tool("search_records", "Search namespace-scoped records with all-tag matching, inclusive observed_from/exclusive observed_to, safe $.payload paths, and lexical FTS OR-term retrieval. Current-only by default; explicit pagination. No raw SQL. Missing values are not fabricated.", searchShape, async args=>jsonResult(ledger().search(args)));
  server.tool("get_record_history", "Return the complete append-first supersession chain for a record id or namespace/kind/key.", selectorShape, async args=>jsonResult({records:ledger().history(args)}));
  server.tool("supersede_record", "Append a full replacement payload correcting a current record. Preserve namespace/kind/key; no deletion or branching. Supply the full corrected record and its new provenance.", {...recordShape,supersedes_id:z.string().min(1)}, async args=>jsonResult(ledger().store(args,args.supersedes_id)));
  server.tool("link_records", "Append a generic relationship between named keys in one namespace. Keys may name records or external entities; this is an observation, not a guaranteed current connection.", {
    namespace:z.string().min(1),from_key:z.string().min(1),relation:z.string().min(1),to_key:z.string().min(1),observed_at:z.iso.datetime({offset:true}).optional(),payload:z.record(z.string(),z.unknown()).default({}),
  },async args=>jsonResult(ledger().link(args)));
  server.tool("search_relationships", "Query relationship observations by exact namespace/from_key/to_key/relation with pagination; historical links are not implicitly current.", {
    namespace:z.string().min(1),from_key:z.string().optional(),to_key:z.string().optional(),relation:z.string().optional(),limit:z.number().int().min(1).max(200).default(50),offset:z.number().int().min(0).default(0),
  },async args=>jsonResult(ledger().relationships(args)));
  server.tool("describe_record_kind", "Describe emergent payload fields/types/presence over up to 5000 current records, observation dates, query usage and a review-only promotion candidate. Never creates domain tables or constrains new fields.", {
    namespace:z.string().min(1),kind:z.string().min(1),
  },async args=>jsonResult(ledger().describe(args.namespace,args.kind)));
  server.tool("render_recap", "Render a run/daily/trial Markdown projection, returning vaultId/filepath/markdown without writing Obsidian. Provide existing_markdown to preserve every byte outside Galaxy markers. Reports provenance, explicit harvest/money sums and arbitrary payloads; no invented prices or missing facts. Daily uses date/timezone. Run follows id to latest correction.", {
    namespace:z.string().min(1),mode:z.enum(["run","daily","trial"]),id:z.string().optional(),date:z.string().optional(),timezone:z.string().default("UTC"),
    include_related:z.boolean().default(true).describe("Run recaps include one-hop related ledger records (current revisions); external entity keys add no invented facts"),
    observed_from:z.iso.datetime({offset:true}).optional(),observed_to:z.iso.datetime({offset:true}).optional(),
    vaultId:z.string().default("wormlife-trial"),filepath:z.string().min(1),existing_markdown:z.string().max(2000000).optional(),
  },async args=>jsonResult(renderRecap(ledger(),args)));
}
