# Nexum integration and source audit

Galaxy treats Nexum as the authoritative source for live wormhole map state. It maintains a local replicated cache, separate from the Wormlife knowledge ledger. No Nexum event writes a ledger record, edits Obsidian, or changes topology.

## Chain identifier reconciliation

Galaxy derives a rooted operational identifier plan from the one `isHome` system and live, non-broken standard wormhole connections. Existing valid custom labels (`t:B.1`) are preserved as durable assignments; unlabelled direct branches allocate `A`, `B`, … and descendants allocate `.1`, `.2`, …. Known-space terminals use `.HS`, `.LS`, or `.NS`. The planner is deterministic, never renumbers surviving valid identifiers, and defers when there is no unique Home or insufficient connected topology.

For each backed directional signature Galaxy plans the literal destination identifier as its `notes` value. A newly scanned wormhole on a known scanner-side system is also assigned a durable provisional identifier immediately—even before its destination node/connection exists—so its bookmark can be copied before jumping. When Nexum later links the destination, that node inherits the reservation. Concurrent known-space exits remain distinct without renumbering the first: `A.LS`, then `A.LS.1`, `A.LS.2` (and equivalently for HS/NS). Every signature direction that moves one link toward Home in the resolved chain tree prefixes the entire generated bookmark with `* ` (for example, `* WH | H | ADE-344 | C2` or `* WH | A | ...`), which sorts it first. An unconnected reservation is released only after a later authoritative Nexum signature refresh confirms that signature is gone; a reservation adopted by a still-live mapped connection is retained. With a **Read + write content** Nexum key Galaxy PATCHes only changed notes through `PATCH /api/v1/maps/:mapId/systems/:systemId/signatures/:sigId` with `{ "notes": "B.1" }`; successful writes are updated optimistically in the local signature cache, so echoed `sig.changed` events do not loop.

Galaxy's note template is an append-first ledger record, not hidden map metadata: use `store_record(namespace="nexum", kind="chain_note_format", key=<canonical Galaxy map ID>, payload={format:"WH | {chain} | {sig} | {dest_type}"}, source_type="user_configuration", status="active")`. Update it with `supersede_record`, then call `nexum_reconcile_chain_notes`. The template supports `{chain}`, `{sig}`, and `{dest_type}`; the latter derives the destination class from the mapped connection target, including a K162 whose Nexum formatter cannot infer a class from a pinned system name. To copy the generated string verbatim in Nexum, set that map's **Signature bookmark** format to `{notes}` in Nexum's UI. Nexum's external API cannot set `bookmarkFormat`.

Nexum's public API intentionally does **not** permit API keys to PATCH map systems or `customLabels`; system/topology writes require a browser session. Galaxy therefore reports each desired `t:<identifier>` custom label in `nexum_chain_identifier_diagnostics`, but does not fabricate a system-label mutation or break normal read/live synchronization. A 401/403 on the first needed signature-note write marks that credential's chain write-back unavailable while reads and events continue normally. Generate/re-enroll a **Read + write content** key to enable note write-back.

## Remote enrollment

Use `nexum_add_credential` over Galaxy's existing authenticated remote MCP connection. Supply `api_key`, optionally `label`, `character_id` (decimal string), and `base_url`. The default instance is `https://eve-nexum.com`. Create a **Read + live events** key in Nexum's UI; non-expiring keys are supported. Enrollment never requires SSH, a CLI, environment editing or direct database access.

Enrollment validates `GET /api/v1/maps`, then briefly opens/closes one accessible map's `/events` endpoint to verify live-event capability. The probe is distinct from the one long-lived managed stream; enrolling an additional credential does not rehydrate an already-live map. Probes may briefly overlap an existing stream during explicit validation. With no accessible maps, read authentication is validated and live-event capability remains unverified until a map becomes accessible.

The API does **not** expose key introspection. Identity, scope and expiry are not returned by `/api/v1/maps`; `/api/keys` and `/auth/me` require browser sessions. `character_id` is therefore labeled `caller_supplied`, character name and exact scope remain null, and `expiry: null, expiry_known: false` means *unknown*, not proof of immortality. The events endpoint admits both `events` and `write` keys; Galaxy cannot distinguish them without an unsupported/unsafe write probe. Galaxy itself issues only GET requests, even if a broader key is mistakenly supplied.

Tools:

| Tool | Purpose |
| --- | --- |
| `nexum_add_credential` | Validate, encrypt, discover access, start background synchronization |
| `nexum_list_credentials` | Safe metadata and access bindings |
| `nexum_test_credential` | Explicit authentication/access/event capability check |
| `nexum_update_credential` | Label, user-confirmed `character_id`, enabled state, validated replacement key |
| `nexum_remove_credential` | Delete Galaxy's copy and bindings; **does not revoke the key in Nexum** |
| `nexum_list_maps` | Canonical maps, access and health |
| `nexum_get_map_state` | Cached metadata, systems, connections, routes and bounded received jump/kill telemetry |
| `nexum_get_system_state` | System, resource lists with timestamps, connections, presence |
| `nexum_get_presence` | Current/history; map, character, EVE system ID, `since` filters |
| `get_wormhole_chain_state` | Map ID/name, optional root/depth, presence/sites; compact graph |
| `nexum_status` | Safe credential counts, access, stream state, timestamps, reconnect count, history count |

Ordinary reads make **zero upstream requests**. Unknown chain fields remain omitted/null; mass/lifetime state is reported from Nexum, not fabricated. Connections preserve both signature references.

To bind an existing credential without re-enrollment, call `nexum_update_credential` with `credential_id` and `character_id` (a positive decimal string of at most 20 digits). Galaxy stores `bound_character_id` and `identity_source: user_confirmed`; this is the user's assertion, not independent Nexum verification. Omitting `character_id` preserves the binding. Identity/label-only updates do not read or replace the key (label secret screening may read it), change map-access bindings, fetch Nexum, or restart streams. Existing JSON metadata storage needs no schema migration.

## Storage, lifecycle and recovery

The additive migration runs when `NexumStore` opens Galaxy's state database. `nexum_maps` is unique on normalized HTTPS instance URL plus raw Nexum map ID; its canonical ID is a deterministic SHA-256 of that pair. `nexum_credentials` stores safe JSON metadata and a secret reference. `nexum_map_access` retains all credential bindings. Map JSON preserves variable topology fields; `nexum_resources` stores per-system signatures, anomalies and structures. `nexum_presence` and `nexum_presence_events` are separate telemetry tables. Unsafe JSON integer tokens are preserved as decimal strings using Galaxy's existing parser.

Galaxy's older ESI token encryption derives its key from host metadata, which is unsuitable for new secret storage. The small reusable `SecretStore` instead uses AES-256-GCM with random nonces, reference-bound authenticated data and a random 256-bit installation key. Ciphertexts reside only in `galaxy_secrets`. The installation key is automatically created alongside the state database (`galaxy-secret.key`, mode 0600; parent created mode 0700). Windows uses the service account's directory ACLs; Node permission modes are not Windows ACL enforcement. Protect that directory and its backups as service-account secrets. Back up the installation key separately from encrypted data; losing it makes enrolled secrets unrecoverable. No operator-created key/environment file is needed to enroll credentials. The key file is ignored by Git.

HTTP request logging recursively redacts secret-named fields and **all arguments** of Nexum add/update tools, including JSON-RPC batches. Authorization headers are never logged. Generic HTTP exceptions no longer dump arbitrary error objects or malformed request bodies. Nexum errors return fixed messages/statuses; response error bodies are discarded. Metadata rejects the supplied key if accidentally reused as a label, identity or URL. Tool results never include the secret reference or decrypted value.

The process-wide singleton starts with both HTTP and stdio Galaxy entry points. Startup discovery runs asynchronously; shutdown cancels streams, pending refreshes and network requests before database teardown. The supported deployment remains one Galaxy process/PM2 fork, as for the existing cache. Multiple operating-system workers would require a distributed stream lease and are not supported.

Each map has one managed stream. Connect first, buffer events, atomically install an authoritative snapshot plus resource lists, then apply buffered events in arrival order. This closes the snapshot/subscription handoff gap. The public full-map endpoint includes metadata, systems, connections and saved routes, but **no signatures, anomalies or structures**; hydration requires one map GET plus three resource GETs per system. New `system.add` rows begin with empty resource lists; later content changes have separate invalidations.

Resource invalidations coalesce for 250 ms by map/system/resource. An explicit merge resync absorbs pending signature/structure invalidations; independent anomaly invalidations remain targeted. Failed targeted refreshes force recovery rather than leaving permanently outdated resources. A missing system during hydration is treated as a concurrent topology change, not proof of lost map access. Full-map 404 removes the credential's binding to that map. Another authorized credential can take over while the old cache remains readable. 401 marks `auth_failed`; 403 marks insufficient scope; transient disconnects do not claim revocation. Backoff is exponential with jitter, capped at five minutes. `Retry-After` seconds and HTTP dates are respected; a 75-second idle watchdog covers Nexum's 25-second keepalive cadence.

Health: `uninitialized` before hydration; `live` after hydration and a healthy stream; `degraded` during disconnection/recovery; `auth_failed` with no usable credential; `stale` for retained disconnected data beyond the threshold. Reads carry timestamps and freshness warnings rather than deleting the cache. Diagnostics also expose sanitized last errors and active credential IDs.

Nexum authenticates only when a REST request/stream opens, and emits no key-revoked/map-access-removed event. Accordingly, a lightweight map-list discovery runs every six hours per healthy credential, also finding newly shared maps; transient discovery failures retry after a minute, respecting rate-limit backoff. It never reloads healthy map content. Removed bindings terminate affected workers. No periodic full-map safety polling is used.

Optional operator tuning (not credential enrollment): `NEXUM_BASE_URL`, `NEXUM_PRESENCE_RETENTION_HOURS` (48), `NEXUM_STALE_SECONDS` (300). Service constructor timing options support tests/embedded deployments, including `accessRefreshMs`. Nonfinite/nonpositive timings fail closed with safe startup diagnostics.

## Presence provenance

The server roster means **who is viewing a map**, not every character online in EVE. It reports character identity, EVE system ID or null, ship type or null, and last heartbeat `ts` in milliseconds. Nexum expires viewers after 60 seconds, swept every 30 seconds, and emits leave on browser stream closure or explicit hide. API-key clients read this roster but do not register themselves as viewers.

Galaxy stores current presence and transitions (including departures inferred from authoritative roster replacement), not every unchanged heartbeat. It prunes history automatically every minute and on historical/current presence queries. A rolling retention-boundary baseline preserves a location that remained unchanged longer than 48 hours; it is labeled `presence.baseline` and retains `baseline_from`, not claimed as a new observation. Queries include the last retained pre-`since` transition per character. This supports approximate reconstruction within retention; it is not a complete EVE movement log, especially across stream gaps. Current stale presence carries the map freshness warning.

Nexum observations have `provenance: nexum_presence`; ESI observations have `provenance: esi_location`. The combined envelope is `source_labeled_telemetry`. A downstream inference must separately label `nexum_presence_inference` with its confidence. It must never become `explicit_user_report` without an actual report. McGreggor, Minner and Renab can share one canonical operating map regardless of which credential supplies its stream.

### Occupancy badge versus streamed viewer presence

The frontend has distinct indicators in `web/src/components/map/SystemNode.tsx`:

* The current-character dot represents the acting character.
* The numbered **alt badge** and its tooltip use `accountHere`, populated by `useAccountLocations`. It excludes the acting character and can include offline characters' last-known positions.
* The numbered **fleet badge** uses `fleetHere`, populated by `useFleet`, excluding the logged-in character. `useFleet` polls browser-session-only `GET /api/character/fleet` every 20 seconds. Its response is `{inFleet,members:[{character_id,solar_system_id,character_name,solar_system_name}]}`. This route is also absent from the versioned key API and has no SSE equivalent. The screenshot was described rather than attached to this investigation, so its badge styling cannot be used to disambiguate alt versus fleet; neither comes from `presence.*`.
* The viewer-presence dot/tooltip uses `presenceHere`, populated by the SSE presence store. It excludes the UI's own viewer when rendering; Galaxy performs no such exclusion.

`web/src/hooks/useAccountLocations.ts` polls `GET /api/character/account-locations` every ten seconds. Its response is `{characters:[{charId,characterId,characterName,online,eveSystemId,systemName,systemClass}]}`. `charId` is Nexum's internal user ID; `characterId` is the EVE ID. `server/src/routes/character.ts` protects this route with `requireAuth` (a browser session), not API-key authentication. There is no equivalent in `apiV1.ts` and no account-location SSE event. More API-key streams cannot recover this missing source.

`useMapPresence` sends `presentSystemIds` for online account characters, but `maps.ts` uses them only to update system activity timestamps. It does not broadcast the alt character identities or their individual locations. Do not infer pilot identity from `system.update.lastActivityAt`.

On 2026-09-10, a bounded direct SSE diagnostic of Cervantes using Minner's key returned a `presence.snapshot` with exactly one viewer (McGreggor, EVE ID `641570826`, system `31000398`), followed by a `presence.update` for the same viewer. Galaxy's live cache matched it. This verified an upstream **API exposure** gap rather than dropped snapshot entries or filtering to the credential's bound character. No alt locations were added to production from screenshot interpretation.

Presence, system-state and presence-enabled chain results expose Nexum coverage plus per-character `esi_augmentation` availability. The Nexum scope remains `map_viewers`; its account/fleet APIs remain unavailable. Missing roster entries are not proof of absence from the system; `presence.leave` means leaving the roster, not a confirmed system departure. A regression test verifies all three entries of a supplied multi-viewer snapshot survive, individual updates/departures affect only that viewer, history retains the transitions, and no REST calls occur. Complete account-location coverage requires a supported Nexum API extension or a separately authorized, distinctly labeled source such as ESI; it cannot be obtained by changing the current SSE normalization.

## ESI location augmentation

User-authorized augmentation supplements the Nexum roster using Galaxy's existing ESI-authorized characters whose IDs match enabled Nexum credential bindings with map access. No new key enrollment or token transfer is needed. Characters without ESI location authorization report missing authorization in coverage. Disabling/removing a binding stops its sampling and contribution; losing ESI authorization excludes its current ESI contribution.

A background scheduler checks every ten seconds while Galaxy is idle, samples at most one character per pass in fair rotation, and waits at least thirty seconds per character or until ESI expiry, whichever is later. Characters shared across maps use one observation. The existing ESI client provides expiry-aware caching, conditional revalidation, request coalescing, foreground priority and error/rate-limit backoff. Failures retry no sooner than sixty seconds and retain visibly stale last-known data with fixed, secret-free diagnostics. Ordinary MCP reads remain local-only. This adds **zero Nexum REST requests or streams**.

| Input | Payload | Action | Upstream calls |
| --- | --- | --- | --- |
| ESI location sample | solar_system_id; optional station_id, structure_id; HTTP cache timestamps | Persist global character location; append only changed location/docking transitions | At most one GET /latest/characters/{character_id}/location/ per idle pass, using existing ESI cache; scope esi-location.read_location.v1 |
| Unchanged/cached ESI response | Same location and original cache observation timestamp | Update freshness without duplicating transitions or renewing a cached observation's timestamp | Zero GET while cache remains fresh |
| ESI error | No trustworthy new location | Retain old timestamp, mark unavailable/stale, back off | No Nexum call; no immediate retry |
| MCP presence/system/chain read | Local observations | Merge by character, retain both sources and conflicts | Zero |

The endpoint and scope were checked against [CCP's current OpenAPI specification](https://esi.evetech.net/meta/openapi.json). No online, ship, fleet, structure-name or public character-name calls are added. Names come from existing ESI authorization metadata. Online remains null: a location is not evidence that a character is logged in.

Current output has one row per character, with all source observations and their timestamps. The latest source timestamp selects the displayed location (Nexum heartbeat ts, ESI cache fetched time); disagreement sets location_conflict. This selection is a telemetry heuristic, not proof of movement. ESI freshness uses its own expires_at/stale fields; map freshness continues to describe Nexum only. Nexum snapshot/leave never deletes ESI data. Bound characters outside the map remain visible in map-wide presence with in_map=false; system/chain filters use the selected location.

Separate additive nexum_esi_locations and nexum_esi_location_events tables persist current locations and rolling 48-hour transitions without ledger writes. History retains both source timelines, including moves outside mapped systems. A labeled esi.location.baseline preserves the original baseline_from at the retention boundary. History gaps are possible during shutdown, foreground activity and upstream failures; this is not a complete movement log. Existing Nexum event handling and the full matrix below are unchanged.

## Authoritative public-source audit

Audited upstream commit: [`7155444eb20348e05f0ff571364f3fecd67409ce`](https://github.com/GQuantrill/eve-nexum/tree/7155444eb20348e05f0ff571364f3fecd67409ce).

Inspected routes and middleware: `server/src/routes/apiV1.ts`, `maps.ts`, `keys.ts`, `auth.ts`, `middleware/apiKeyAuth.ts`; read projections in `services/mapRead.ts`; emitters in `mapStream.ts`, `mapEvents.ts`, `presence.ts`, `mapWrite.ts`, `connLifetimeSweep.ts`, `whSweep.ts`, `crossMapSync.ts`, `killFeed.ts`, `connectionJumps.ts`; client consumers in `web/src/hooks/useMapEventStream.ts`, `web/src/store/mapStore.ts`; presence and map-merge integration tests, lifetime sweep tests, and the test-file inventory. No dedicated versioned API/SSE integration test file was found in that inventory; Galaxy's tests exercise the audited contract independently.

SSE uses unnamed `data: JSON` frames dispatched by JSON `type`. Events carry no replay ID and the in-memory publisher keeps no durable history. `: connected` opens the stream; `: ping` occurs every 25 seconds. Every connection supplies `presence.snapshot`. The browser's `open` handler invokes `switchMap` on reconnect; `map.resync` also invokes `switchMap` after bulk merge. Galaxy mirrors the authoritative reload and refreshes the separately cached intel that can change. Reconnect requires **one map GET + three per-system resource GETs**. The sole audited `map.resync` producer is a merge, which changes signatures/structures but never copies anomalies: merge resync requires **one map GET + two per-system GETs**, preserving existing anomalies and initializing new nodes with empty anomalies. Independent anomaly invalidations still trigger their one targeted GET. The versioned API has no bulk intel endpoint.

### Exact payload shapes

All rows below include `type`. Most map-edit events include `actor: string | null`; `presence.snapshot` and `presence.leave` do not. No actor echo suppression applies to Galaxy, which never writes upstream.

* **System**: `id, eveSystemId, name, systemClass, effect, statics, regionName, npcType, position:{x,y}, status, intel, isHome, locked, notes, labels, customLabels, tag, alias, security, lastActivityAt`. Full-map reads additionally retain raw `x,y`; the add emitter folds them into `position`.
* **System updates**: `id, updates`, whose writable fields are `name, systemClass, effect, statics, regionName, npcType, status, isHome, locked, notes, intel, tag, alias, labels, customLabels, position`; server background updates also send `lastActivityAt`. The emitter copies request updates, so unknown keys may occur. Galaxy preserves forward-compatible fields, merges partial position, and mirrors DB alias trimming/label deduplication. Normal system PATCH does **not** emit its newly written `last_activity_at`; that timestamp can lag until another activity event/reload. No fetch is added merely to refresh this cosmetic timestamp.
* **Connection**: `id, sourceId, targetId, sourceHandle, targetHandle, connectionType, massStatus, timeStatus, size, type, massUsed, eolAt, lifetimeExpiresAt, broken, flagIcon, flagNote, flagBlink, flagColor, sourceSignatureId, targetSignatureId, createdAt`. Updates contain `id, updates` with any writable connection fields (all except endpoints, ID and created timestamp); server-derived size/time changes are included.
* **Route**: `id, name, systemIds, connectionIds, createdAt, updatedAt`; updates carry `id, updates` with `name, systemIds, connectionIds` when supplied.
* **Viewer**: `characterId, characterName, eveSystemId, shipTypeId, ts` (the latter two IDs/location may be null as upstream specifies).
* **Jump**: `id, connectionId, direction, fromEveSystemId, toEveSystemId, fromSystemName, toSystemName, characterId, characterName, shipTypeId, shipTypeName, shipGroup, shipMass, hot, jumpedAt`.
* **Kill**: `killmailId, atMs, eveSystemId, systemName, regionName, shipTypeId, shipTypeName, totalValue, victimCharacterId, victimName, victimCorporationId, victimCorpName, npc, finalBlow`; `finalBlow` is null or `{characterId,name,corporationId,corpName,shipTypeId,shipName}`.
* **Map metadata patch**: optional `name, locked, allowAsMergeSource, allowAsMergeDestination, skipKspace, lazyRemoveWormholes, collapseGraceHours, bookmarkFormat, siteBookmarkFormat`.

Resource REST arrays are authoritative replacements:

* Signatures: `id, sigId, sigType, name, notes, whType, whLeadsTo, ghostType, createdAt, updatedAt`.
* Anomalies: `id, anomId, anomType, name, notes, createdAt, updatedAt`.
* Structures: `id, name, structureType, ownerCorp, eveId, notes, createdAt, ownerCorpId`.

### Complete event/action/REST matrix

`M = /api/v1/maps/{nexumMapId}` and `S = M/systems/{systemId}`. Shape names below refer to the exact field lists above. IDs are upstream IDs, not Galaxy's canonical hash. Every endpoint uses GET.

| Event | Actual payload besides type/actor | Completeness | Galaxy action | REST? | Exact endpoint | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `presence.snapshot` | `viewers: Viewer[]`; no actor | Full current roster | Replace roster; record only transitions | No | — | All presence state supplied |
| `presence.update` | Viewer fields, actor | Full one viewer | Upsert current; record transition if changed | No | — | Complete viewer payload |
| `presence.leave` | `characterId`; no actor | Authoritative deletion | Remove viewer; record departure | No | — | ID suffices for removal |
| `system.add` | `system: System` | Full entity | Add directly; initialize new empty intel | No | — | Canonical row is re-read by Nexum emitter |
| `system.update` | `id, updates` as above | Partial delta | Merge supplied changes | No | — | Existing baseline plus delta suffices; timestamp caveat above |
| `system.remove` | `id` | Authoritative deletion | Remove system, incident edges, cached intel | No | — | No missing state to fetch |
| `connection.add` | `connection: Connection` | Full entity | Add directly | No | — | Uses canonical CONNECTION_COLS projection |
| `connection.update` | `id, updates` as above | Partial delta | Merge supplied changes | No | — | Includes derived size/time changes |
| `connection.remove` | `id` | Authoritative deletion | Remove edge | No | — | ID suffices |
| `sig.changed` | `systemId` | Invalidation | Coalesced replacement of system signatures | Yes, 1 | `S/signatures` | No signature objects in event |
| `anom.changed` | `systemId` | Invalidation | Coalesced replacement of system anomalies | Yes, 1 | `S/anomalies` | No anomaly objects in event |
| `structure.changed` | `systemId` | Invalidation | Coalesced replacement of system structures | Yes, 1 | `S/structures` | No structure objects in event |
| `map.meta` | Optional map metadata patch above | Partial delta | Merge metadata | No | — | Supplied fields are the change |
| `map.resync` | No state fields | Explicit merge invalidation | Reload topology/signatures/structures; preserve anomalies | Yes, `1+2N` | `M`; for each system `S/signatures`, `S/structures` | Only producer is merge; it never copies anomalies |
| `route.add` | `route: Route` | Full entity | Add saved route | No | — | Complete saved-route row |
| `route.update` | `id, updates` | Partial delta | Merge route | No | — | Baseline plus delta |
| `route.remove` | `id` | Authoritative deletion | Remove route | No | — | ID suffices |
| `route.reorder` | `orderedIds: string[]` | Ordering delta | Reorder, retaining unlisted tail | No | — | Same semantics as client |
| `jump.logged` | `connectionId, jump: Jump` | Full one crossing | Upsert bounded received jump telemetry | No | — | Complete row; never adjusts mass |
| `jump.updated` | `connectionId, jump: Jump` | Full one crossing | Replace received crossing | No | — | Canonical updated row returned by emitter |
| `jump.cleared` | `connectionId` | Authoritative deletion | Clear received jumps for connection | No | — | ID suffices |
| `kill.recent` | Kill fields, actor null | Full decorated kill | Deduplicate bounded received kill telemetry | No | — | No requested heatmap/backfill dependency |
| `: connected`, `: ping` | SSE comments, no JSON | Transport keepalive | Update stream activity/watchdog | No | — | Not invalidations |
| Reconnect/open | Transport transition; new presence snapshot | No missed-event replay | Buffer and hydrate before marking live | Yes, `1+3N` | `M`; for each system `S/signatures`, `S/anomalies`, `S/structures` | Upstream client explicitly reloads; any resource may have changed |
| Unknown/malformed | Unrecognized or invalid fields | Unusable | Ignore safely; compact diagnostic | No | — | Do not invent a fetch contract |

Additional limitations: jump/kill history has no versioned backfill routes and is only the bounded telemetry received this session (100 kills, 500 jumps), reset on authoritative hydration. Resource events cannot be applied directly because their payloads contain only identifiers. Disconnected presence is not evidence a pilot left EVE. The source audit is pinned to a commit; deployed instances may run a different version, so unknown fields/events are handled without crashing.

## Verification

`npm run build` compiles the integration. `npx vitest run` runs Galaxy's complete suite. New tests cover actual HTTP MCP enrollment/log redaction; encrypted storage and restart; multi-character canonical identity and stream count; zero-call cached reads/direct events; exact invalidation/resync call counts and coalescing; handoff buffering; malformed and 64-bit events; auth failure/failover, access loss, replacement/removal; presence transitions/history/pruning; stale-readable health; and transport Retry-After/redirect behavior. No real keys are committed as fixtures and no tests require a live Nexum account.

### ESI augmentation verification (2026-09-10)

Build passed; complete suite: 30 files, 280 tests passed. Five new ESI tests cover shared reads, three-character merging, zero-call cached reads, independent viewer removal, conflicting/out-of-map movement, authorization loss, sanitized errors, 48-hour baselines, persistence and in-flight shutdown. Live local MCP after PM2 restart returned all three bound characters in J154212 (31000398), all three ESI sources available, three ESI history entries and live Nexum map health. At verification Nexum supplied Minner; ESI supplemented McGreggor and Renab. ESI samples can expire between background passes and are explicitly labeled stale/last-known.
