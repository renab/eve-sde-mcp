# Automatic player-structure metadata

Galaxy automatically resolves player-structure IDs in ESI read-tool results. Original IDs remain accessible. No manual mapping, SDE changes, knowledge-ledger records or new MCP tool is needed. `get_structure` shares this resolver and retains the original ESI fields, adding local type/system names and cache provenance.

## Coverage

The central ESI-tool response boundary handles nested snake_case/camelCase structure, station, location, facility, contract start/end, blueprint-location and output-location fields. This covers location/clones, assets, jobs, orders, transactions, contracts, blueprints and structure listings. Industry jobs additionally retain their previously omitted station/blueprint/output location IDs. Ledger records and recaps are not traversed.

`structure_id` or `structureId` gains a sibling `structure` object. Other location fields gain a sibling such as `location_structure`, `facility_structure`, or `blueprint_location_structure`. These objects include name, original structure ID, system/type IDs and SDE names, owner, position when available, and cache metadata: fetched/expiry/next-refresh times, actual auth character, stale flag and last-error details.

NPC stations and systems below the player-item ID range (one trillion) are not sent to the player-structure endpoint. Explicit asset item/container locations are skipped. Ambiguous large `other` locations can be probed, with failures negatively cached. Each response deduplicates candidates and resolves at most 10 distinct IDs serially to prevent unbounded inventory/market fan-out; remaining IDs receive a budget warning suggesting `get_structure`. Resolution failures never fail the parent response.

## Cache and access

`structure_resolutions` lives in the existing `galaxy-state.db`, keyed by exact decimal structure ID and authentication character. It retains the last successful metadata separately from refresh errors. Lookups use only `esiGetWithMetadata`: normal HTTP cache, validators, single-flight and global/error-limit backoff remain in force.

Upstream expiry is respected. A **four-hour fallback TTL** is used only when upstream freshness headers are absent. Explicit no-cache/max-age-zero/expired responses are not made artificially fresh; no-store responses are not persisted. Structure names and ownership are mutable, not immutable SDE facts.

Refresh failures preserve last-known metadata as explicitly **stale historical information**, with original fetched time and separate last-error/time. This does not establish current existence, name, ownership or docking access. Negative/access failures defer retries for **15 minutes**, or longer if upstream backoff requires it. Internal callers can disable stale fallback. Historical stale metadata is never inserted into the HTTP cache as a fresh success.

The calling character is preferred, otherwise the active character is used. Required scope: `esi-universe.read_structures.v1`. No automatic cross-character fallback is attempted. ESI enforces private-structure access. Cache partitioning prevents a success under one character from silently becoming a fresh success for another. Missing metadata leaves raw IDs intact; `get_structure` returns an explicit warning when no usable result exists.

## 64-bit identifiers

`get_structure` accepts safe integer numbers or exact decimal strings within signed 64-bit range. Unsafe numeric inputs are rejected. ESI JSON integer tokens outside JavaScript's safe range are preserved as strings before parsing, including in other endpoint results; safe values remain numbers. Asset/market location filters now accept exact strings and compare decimal representations. Older cached values that were already rounded cannot be reconstructed without an eligible upstream refresh or exact caller-supplied ID.

Automated tests use mocks/fixtures. No structure or character is hard-coded into application logic. HTTP lookup latency/backoff still applies, and there is no guarantee of access to any particular private structure.
