# Galaxy persistence

Implementation brief: `wormlife-trial/05 Planning/Galaxy Persistence - Codex Handoff.md`, read in full before implementation.

## Architecture and ownership

Galaxy extends its existing ESI client, `better-sqlite3` dependency and MCP registration pattern. No second server/framework or new dependencies are needed. `persistence.ts` owns storage, `esi-cache.ts` owns HTTP cache/backoff, `ledger.ts` owns records and retrieval, and `recaps.ts` renders derived Markdown. All are inside Galaxy.

Obsidian is unchanged generic infrastructure. Galaxy owns facts/provenance; Obsidian owns narrative, strategy and annotations. No import/sync, templates, configuration, migrations, service restarts or code changes are made in Obsidian. No historical Wormlife records are automatically imported.

## SQLite layout and operations

Default: `%USERPROFILE%\.eve-sde\galaxy-state.db`. Override with `GALAXY_STATE_DB` when needed. This is separate from replaceable `eve.db` SDE and encrypted `auth.db`. Tables are created idempotently on first use:

- `esi_cache`: canonical hashed request identity, endpoint, expiry, JSON payload and HTTP metadata.
- `esi_backoff`: persistent upstream/endpoint/cache cooldown deadlines.
- `records`: generic JSON records with namespace/kind/key, timestamps, provenance, status, tags and supersedes link.
- `records_fts`: FTS5 lexical search projection.
- `relationships`: generic directed observed links with JSON metadata.
- `query_usage`: kind-scoped query count and total duration, used as an introspection signal.

WAL, foreign keys and a 5-second busy timeout are enabled. No EVE-domain tables or automatic promotions exist. Cache capacity is bounded to 5,000 entries; ledger history has no automatic expiry. Cache rows and cooldowns survive restart. Tests use isolated memory databases and an explicit temporary-file durability check, not production state.

The database contains private facts in plaintext, **not access/refresh tokens**. Protect its directory with the same user-level access controls as other local data. Namespaces are organizational scopes, not separate security principals: the existing authenticated MCP remains the access boundary. Back up with SQLite's backup API, or stop Galaxy and copy the state database together with any WAL/SHM companions. Never replace/delete this database during an SDE refresh. Restore a consistent SQLite backup, not an arbitrary live copy of the main file alone.

## ESI safety

- Fresh hits do not call ESI. Existing auth checks still apply; an expiring SSO credential may refresh separately.
- Cache freshness is derived from Cache-Control/max-age or Expires, adjusted for Date/Age and request duration. Last-Modified is a validator, never a layout-change gate or a substitute freshness timestamp.
- Expired entries use If-None-Match (or If-Modified-Since); a 304 preserves data and merges new headers. `no-store` is not persisted; `no-cache` requires validation. No invented success polling TTL exists.
- Public reads share keys across character selections. Private entries are partitioned by authenticated character and scopes, without bearer tokens in keys. Query parameters are canonicalized for key identity.
- Concurrent refreshes coalesce within the running Galaxy process, including the HTTP server's per-request MCP instances. Token refreshes also coalesce by character. The deployment is a single PM2 worker; do not run a multi-worker cluster expecting a distributed refresh lock. SQLite persists data/backoff across processes but the single-flight map is process-local.
- Error-limit remaining below 20 pauses all new upstream traffic through reset. 420/429 apply conservative global cooldowns; Retry-After (seconds or HTTP date) is a lower bound. 5xx GET retries are bounded to two, use exponential delay plus jitter, and defer rather than block for long waits. Network failures have a 30–35s cooldown. Requests have a 30s timeout. Writes are never automatically retried.
- Retry/error cooldowns persist. Fresh hits still work during a pause. Repeated failures do not cause a tight loop. Read 4xx errors remove the cached representation and impose a short negative cooldown, without stale fallback.
- `force_refresh` on PI tools requests refresh **only when eligible**; it cannot shorten ESI freshness or bypass backoff. Writes likewise no longer indiscriminately clear all fresh ESI responses. A newly saved fitting can therefore remain absent from a previously cached fitting list until upstream expiry.
- Stale-on-error is opt-in, limited to 24-hour-old snapshots and transient network/availability failures. It is prohibited for no-cache/no-store/must-revalidate and permission/not-found errors. PI returns `cacheStatus: stale_on_error`, original fetched timestamps, `staleReason` and `retryAt`. Data-only legacy helpers deliberately fail rather than hide a stale marker. No unlabelled stale values are returned.
- PI retains its semantic-staleness caveat: viewing/interacting with the colony in-client can be required before ESI contents change. Polling harder does not fix semantic lag. Colony list and detail remain independently cached.

Existing metadata fields remain; `revalidated` and `stale_on_error` are new cache statuses. Generic ledger storage does not automatically convert every transient ESI cache row into a permanent factual snapshot. Store selected facts explicitly with source references and freshness metadata in their payloads.

Upstream reference: [ESI best practices](https://developers.eveonline.com/docs/services/esi/best-practices/).

## Stable ledger tools

| Tool | Semantics |
| --- | --- |
| `store_record` | Append a new generic JSON record. A duplicate namespace/kind/key requires explicit supersession. |
| `get_record` | Exact namespace/id, or authoritative current namespace/kind/key. Explicit historical IDs stay historical. |
| `search_records` | Namespace required; optional kind/key, all-tag match, observed date interval, JSON filters, FTS, pagination. Current-only defaults true. |
| `get_record_history` | Complete explicit correction chain, including unkeyed records. |
| `supersede_record` | Append a full corrected record with `supersedes_id`; preserve namespace/kind/key. No partial payload merge, deletion or correction branches. |
| `link_records` | Append a namespace-scoped directed relationship between record IDs/keys or external entities. |
| `search_relationships` | Exact namespace/from/to/relation filters and pagination. Links are observations, not an inferred current topology. |
| `describe_record_kind` | Emergent fields/types/presence, observed dates, query counts and promotion review signal. |
| `render_recap` | Run, daily or trial Markdown projection; returns publication data only. |

New kinds and payload fields need no migration or registry. JSON is limited to 256 KiB and 32 nesting levels per payload; undefined/non-JSON values are rejected. Metadata timestamps accept offsets and are normalized to UTC. Created time is assigned by Galaxy. Observed time and provenance may be absent and then stay explicitly unknown, never inferred from insertion time.

Supersession is atomic and requires an existing current predecessor with the same identity. A unique predecessor reference prevents branching. Both payloads and their provenance remain intact. Source labels are supplied claims, not independent validation of truth. Correct facts in Galaxy first, then regenerate notes.

## Safe queries

Example filter: `{path: "$.payload.harvest.C72", op: ">=", value: 4000}`.

Paths support identifier property names and nonnegative array indexes; no arbitrary SQL, wildcards, expressions or quoted-key syntax. Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `exists`, `in`. Scalars and in-lists are bound parameters; comparisons are type-aware for numbers/strings/booleans. `exists` tests JSON presence (including explicit null); use `value: false` for absence. Missing/explicit-null comparisons otherwise follow SQLite JSON NULL behavior. `contains` supports string substrings or exact array membership. Tags use all-match semantics. Date range is inclusive `observed_from`, exclusive `observed_to`; undated records do not match a date range. Search limits default 50, maximum 200, with `nextOffset`.

FTS tokenizes/stems the stored JSON projection and uses escaped OR terms after a small stop-word filter. It supports conversational wording as **lexical retrieval**, not embeddings or guaranteed semantic interpretation. Structured filters should narrow broad text matches. Search results use observation/creation order, not a semantic relevance claim.

## Emergent schema and promotion

Introspection counts current authoritative records and samples up to the latest 5,000. It reports nested object paths, array fields, observed types, occurrence count and presence percentage. Arrays remain arrays; it does not impose a schema on their members. Observation min/max spans all current records, while field percentages are explicitly sample-based.

Promotion is a review-only heuristic: at least 30 current records, fields with >=90% presence and one observed type, and at least 10 kind-scoped searches. It cannot infer stable *meaning* from JSON, so human review is mandatory. No automatic view/table/migration is created. First consider a SQL view over source JSON; materialize/index only after measured usage justifies it. Original provenance and history remain the authority.

## Recaps and publishing

Run mode follows an ID to its current correction; by default it includes one-hop related records. Use `include_related: false` for a single record. Daily mode takes `date` and IANA `timezone` (default UTC); trial mode accepts optional observed date bounds. Daily excludes undated facts. Selections over 5,000 records or more than 200 run links fail explicitly rather than silently truncate.

Recaps include arbitrary recorded payload fields and provenance. They sum explicit `harvest` quantities and optional `income_isk`, `expense_isk`, `sale_isk`, `estimated_value_isk` fields separately by source type. These are rendering conventions, not required record schemas. No market price fetch, price invention, unit inference, wallet reconciliation, strategy inference or fabricated total occurs. Different economic/source bases are not blended into a purported net profit; record details retain full source references and estimation basis. Interim observations remain labeled. Other kinds still appear as detailed source records without invented calculations.

Outputs are `{vaultId, filepath, markdown, recordIds, existingContentHash, publicationRequired}`. Supply the existing note text for regeneration. Only a single well-formed `GALAXY:GENERATED:START` / `GALAXY:GENERATED:END` region is replaced. Human text before and after is byte-preserved. No markers means append a new generated region; malformed/duplicate markers fail closed. Content is Markdown-escaped to prevent record values injecting marker boundaries.

ChatGPT must read the current Obsidian note, request a projection with `existing_markdown`, and use the existing generic Obsidian MCP only after checking that the note has not changed. The hash describes the input; it is not a distributed write lock or atomic compare-and-swap. If the note changed, rerender first. Galaxy does not publish, synchronize, backfill, or edit Obsidian itself.

## Scope/deviations

No giant migration, fixed EVE ontology, specialized domain tables, automatic promotion, semantic embeddings, or Obsidian integration code is included. The first recap layer is intentionally conservative generic projection plus explicit-field arithmetic, not an economic inference engine. Cache coalescing is scoped to the deployed single-worker process; distributed workers would require an additional lease mechanism. Stale fallback is limited to metadata-bearing PI tools to preserve other endpoints' response semantics. These limits are explicit rather than hidden behind unverified safety or completeness claims.
