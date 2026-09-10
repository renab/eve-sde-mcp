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
structure, corporation, location, type, station, region, constellation and alliance
IDs. Typed snake-case suffixes such as `observer_character_id`,
`blueprint_type_id`, and `fortizar_location_id` also work. Nested objects and arrays
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
- `get_planetary_colonies`, `get_planetary_colony`, `get_system`, `get_type`, and
  `get_structure` advertise current record pointers by default. Set
  `include_related=false` to omit them or `record_namespace` to select a namespace.
  Existing response fields are preserved.

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
fresh audit or must be excluded from its approved scope. There is deliberately no
automatic production backfill command.

The motivating spec's sample system ID `31002238` is J115405 in the SDE.
J154212 is `31000398`; its planet VIII is `40371521`. Do not propagate the sample
system ID when resolving the historical corpus.
