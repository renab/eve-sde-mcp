# Entity relationships

Galaxy maintains normalized entity references alongside its append-first ledger.
New `store_record` and `supersede_record` writes index explicitly typed stable IDs
without changing payloads. Schema initialization adds empty side tables; it never
backfills existing records. Older rows report `entity_indexed: false`.

## Record metadata

```json
{
  "namespace": "wormlife",
  "kind": "planet_resource_density",
  "payload": { "planet_id": 40371521 },
  "entity_refs": [
    { "type": "solar_system", "id": "31000398" },
    { "type": "character", "id": "641570826" }
  ],
  "related_galaxy": [
    {
      "relation": "current_state_for",
      "subsystem": "esi_planetary_colony",
      "entity_refs": [
        { "type": "character", "id": "641570826" },
        { "type": "planet", "id": "40371521" }
      ]
    },
    {
      "relation": "related_colony_history",
      "namespace": "wormlife",
      "kind": "pi_colony_snapshot",
      "entity_refs": [{ "type": "planet", "id": "40371521" }]
    }
  ]
}
```

Entity types are extensible lowercase identifiers. IDs are positive safe integers
or exact decimal strings (returned as strings). Unsafe numeric IDs are rejected in
explicit refs and ignored during automatic extraction. Use strings for large IDs.
Names are display metadata; ingestion never guesses identity from names.

Recognized payload fields include snake/camel-case character, solar-system, planet,
structure, corporation, location, type, station, region, constellation, alliance,
item, contract, killmail, moon and faction IDs. Typed snake/camel-case suffixes such
as `observer_character_id`, `blueprintTypeId`, and `fortizar_location_id` also work.
`systemId` maps to solar system, `skillId` to type, and `facilityId` to location.
Typed ID arrays, implants and infested solar systems are recognized. Explicit
`context_id_type`, `location_type`, and standings `from_type` discriminators resolve
otherwise ambiguous fields; an untyped party/owner ID is never guessed. Nested objects and arrays
are inspected. Bare `id`, `owner_id`, signatures and arbitrary numbers are ignored.
There is a 1000-ref ceiling per record; duplicate `(type,id)` pairs are collapsed.
Explicit refs take precedence over extracted duplicates. Supersession is a full
replacement: callers must resupply metadata they want retained, as with payloads.

`record_entity_refs` indexes `(entity_type,entity_id,record_id)` and associates each
reference with the exact record revision. `record_entity_metadata` records typed
relationships and whether a revision has been indexed. Both are written in the
same transaction as the record. Original records, FTS data, observation timestamps,
provenance, and explicit supersession chains retain their existing semantics.

## Discovery tools

- `get_entity_context(entity_type, entity_id, namespace="wormlife")` finds matching
  current record pointers and available sources. Additional `entity_refs` require
  all IDs to occur in a matching record; this means co-reference, not ownership.
- `get_record` / `search_records`: `include_related=true` adds entity matches,
  bounded typed targets, and `available_sources`. `include_live_sources=false`
  suppresses source discovery. `relation_depth` is 0 or 1.
- All ESI read tools advertise current record pointers by default, including
  skills, wallets, market, industry, assets, contracts, fittings, killmails, LP,
  navigation, PI, character state, corporation operations, and universe activity.
  The SDE `get_system` and `get_type` integrations also remain available. Set
  `include_related=false` to omit them or `record_namespace` to select a namespace.
  Existing response fields are preserved.

## Shared ESI response layer

The server registration boundary adds the same discovery controls and response
enrichment to every `get_*` tool in its ESI tool families, plus
`check_skill_requirements`. This currently covers 57 read tools, including the
SDE schematic and locally tracked LP reads in those families. Save/delete,
autopilot writes, authentication, keep-warm management, and ledger mutations do
not participate. New read tools in these families inherit coverage automatically.

Request identity is captured using `AsyncLocalStorage`, from the selected
character and successful ESI resource paths. This makes scalar wallet balances,
empty collections, corporation operations, and responses containing only names
discoverable without fetching identity again. Concurrent calls retain separate
identity sets. Path strings, tokens and raw ESI payloads are not retained in this
context. Final output is inspected **after filtering/pagination**; discarded
upstream rows do not become response matches. Explicit request filters remain
available as clearly labeled request context.

Object responses gain a response-wide `related_records` list. Each pointer has
`matched_entity_refs` (at most 10) and `match_scope` distinguishing
`response_entity` from `request_context`. Returned-entity matches are prioritized
before broader request context. `related_record_context` reports namespace,
limits, `has_more`, and whether scanning was truncated. Follow a matched entity
through `get_entity_context` for more records. Existing business-data pagination
fields such as `nextOffset` are never overwritten.

Existing PI per-colony pointers and PI/structure top-level pointer contracts stay
intact. When a top-level pointer list already exists, extra response-wide matches
are in `related_record_context.additional_related_records`. Array/scalar first
content blocks retain their original shape and receive a second JSON text block
containing the discovery summary. Human-readable failures and MCP errors remain
unchanged. An unavailable index is explicitly labeled `status: unavailable` and
does not discard a successful ESI response or claim there are no matches.

The common summary defaults to 10 unique records (maximum 50), in addition to
existing bounded per-colony lists. Scanning has a 20,000-visit / 1000-entity budget
per response and excludes previously generated relationship metadata. Discovery
uses at most two batched indexed queries plus metadata reads for selected
pointers. It performs no ESI calls and never writes its annotations into ESI cache
entries: newly stored records appear even on otherwise unchanged fresh cache
hits. Existing structure-name enrichment retains its separate behavior.

Default pointers contain IDs/keys, relation, source, original provenance/status,
observation timestamps, and `is_current`. They omit payloads. Lists default to 10
and cap at 50. `nextOffset` signals more matches. Endpoint pointer pages can be
continued through `get_entity_context` for the same entity. `current_only=false`
in context enables history, ordered with current revisions first. Different keys
are not silently merged just because their timestamps differ.

The entity-context source list is bounded separately (default 5, maximum 10) and
derived from the requested entity plus the current page of matches. Record
discovery is namespace scoped, including typed targets. Cross-namespace and unknown
subsystem pointers remain stored metadata; they are not traversed automatically.
Flat records containing multiple planets/characters never create a cross-product
of colony ownership claims. Explicit compound subsystem pointers can disambiguate.

## Optional source resolution

Source pointers identify logical Galaxy subsystems and tools, never durable HTTP
URLs. Initial adapters cover `sde_system`, `sde_type`, `esi_planetary_colonies`,
`esi_planetary_colony`, and `esi_structure`. This is an extensible adapter boundary,
not a per-record-kind resolver. Structures and types exercise the non-PI path.
Other entity types already support record lookup; more source adapters can be
added without changing storage. In particular, a `location` is not automatically
asserted to be a `structure`, and a character reference is not an ownership claim.

`get_entity_context` keeps resolution off by default. `resolve_live=true` resolves
the bounded ESI sources; `resolve_sde=true` resolves static sources. The existing
authentication, scopes, cache freshness, backoff, and stale-data metadata apply.
PI uses the referenced character. Structure resolution uses the active character
and reports its auth/cache provenance. Source failures are returned alongside
successful discovery rather than hiding the matching records. No recursive
ESI -> ledger -> ESI traversal occurs. `esi_live` identifies the source family;
cache metadata still governs how fresh the returned data actually is.

## Historical backfill workflow

Run `npm run build`, then:

```powershell
node scripts/audit-entity-backfill.mjs C:\path\galaxy-state.db artifacts/entity-backfill-audit.json
node scripts/verify-entity-audit.mjs C:\path\galaxy-state.db artifacts/entity-backfill-audit.json
```

The audit opens the live ledger and local SDE **read-only**. It inventories every
Wormlife kind/revision, fingerprints original fields, and separates direct IDs,
deterministic name candidates, and unresolved identities. Exact SDE matching,
Roman planet-ordinal conversion, blueprint-copy label normalization, and exact
unambiguous corpus character names are audit-only proposals, not ingestion rules.
The simulator copies records into an in-memory database, indexes proposed refs
there, and checks PI discovery and unchanged record fields. It never applies the
manifest to the live database. Audit artifacts stay local and out of Git.

Present the audit and obtain approval before historical indexing. An approved
migration should revalidate fingerprints and identities, append only side-table
metadata, preserve all payload/provenance/history fields, record skipped rows,
and report before/after counts. New records arriving after the audit require a
fresh audit or must be excluded from its approved scope. Backfill is never run
automatically by schema initialization, ingestion, or an ESI read.

After explicit approval of a saved manifest, the operator can verify it against
ESI and apply exactly its eligible revisions:

```powershell
node scripts/verify-backfill-identities.mjs artifacts/entity-backfill-audit.json artifacts/entity-backfill-esi-verification.json
node scripts/apply-entity-backfill.mjs --apply-approved C:\path\galaxy-state.db artifacts/entity-backfill-audit.json artifacts/entity-backfill-esi-verification.json artifacts/entity-backfill-run APPROVED_COUNT SKIP_COUNT
```

The verifier checks SDE system/planet/type/station identities against ESI, validates
character/corporation identities and accessible structures, and checks recorded
PI character/planet pairs against current colonies. It uses normal Galaxy
authentication/cache/backoff rules, binds evidence to the exact manifest hash,
and reports conflicts. This does not validate historical survey measurements or
infer past ownership from today's state. Structure verification uses McGreggor's
existing authentication for this Wormlife migration.

The application command requires successful evidence no older than 24 hours and
the approved eligible/skip counts. It rechecks record fingerprints, namespace,
kind and key inside an immediate transaction, saves original ledger/index rows
before insertion, and appends only entity-reference/metadata side-table rows.
Current/superseded status is calculated from the live chain. Skipped and newer
records' indexes are compared before/after, and original record fields must stay
identical or the transaction rolls back. Conflicting existing indexes abort;
matching indexes are idempotently retained. Use a fresh output prefix on a retry
so the earlier backup/report cannot be overwritten. No runtime restart is needed
for these index additions.

The motivating spec's sample system ID `31002238` is J115405 in the SDE.
J154212 is `31000398`; its planet VIII is `40371521`. Do not propagate the sample
system ID when resolving the historical corpus.
