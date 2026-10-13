# WormholeSystems → Galaxy: bounded source integration

## Objective

Make WormholeSystems-derived chain/bookmark authority available to Galaxy for **one explicitly enabled Nexum map**, without assuming an undocumented upstream deployment contract or changing Nexum topology. This is the prerequisite for [02-wormholesystems-nexum-reconciliation.md](02-wormholesystems-nexum-reconciliation.md).

## Authority

- The initiating request requires WormholeSystems → Galaxy → Nexum integration and replacement of obsolete B/B.1-style note authority on the selected map. The named current WormholeSystems authority records were not present in this repository and their current payload/supersession cannot be established here. Do not interpret legacy chain labels as the new authoritative bookmark specification.
- `docs/nexum.md` describes the existing Nexum cache, canonical map identity, signature-note PATCH limitations, read/live behavior, and UI-only bookmark format. `src/nexum-chain.ts`, `src/nexum.ts`, `src/nexum-store.ts`, `src/nexum-client.ts`, and `src/secrets.ts` are the implementation boundaries.
- No verified alliance deployment API schema, authentication protocol, or change-notification mechanism is available. A fixture contract is a local validation boundary, **not** a claim about live upstream endpoints.

## Scope and dependencies

1. Introduce a small, replaceable **GET-only** WormholeSystems client/adapter, independent of the existing Nexum transport and of bookmark rendering. Define configuration for approved HTTPS origin, credential reference, enabled canonical Nexum map ID, bounded request settings, and an explicit source identity/namespace. Do not ship a guessed default endpoint or URL. Reuse `SecretStore` for any credential; metadata and MCP output must not contain credentials.
2. Define a versioned internal snapshot fixture and normalization contract. Include source identity, source revision (or a stable content digest when the upstream supplies no revision), retrieval/observation timestamp, scope, systems identified by EVE solar-system IDs, directional signature identity, connection identity, connection state and freshness, and **the actual authority fields required by the requested bookmark specification once confirmed**. Preserve separate nullable/unknown fields rather than deriving them from Nexum names or labels. Validation rejects unrecognized required shapes, inconsistent references, missing identity or contradictory duplicate keys, with sanitized diagnostics. Do not assume any particular live JSON shape: adapter maps verified upstream payloads to this canonical model and fixture tests pin that mapping.
3. Add a per-target-map persisted source snapshot and sync run journal/provenance: configured origin/source identity, source revision/digest, `fetched_at`, validated `observed_at` where supplied, selected canonical map ID, adapter/fixture version, last attempt/success/error, and whether data is eligible for matching/write planning. Do not store credentials or request headers in these rows. Keep existing Nexum cache, `nexum_chain_reservations`, and ledger independent; use additive migration and transactional snapshot replacement, never partial snapshots.
4. Expose an **on-demand**, authenticated MCP operation for source sync (e.g. `wormholesystems_sync_map` with canonical `map_id`; response: source revision, counts, freshness, eligible/skipped diagnostics, and whether Nexum writes were attempted). Add a read-only status/preview operation (e.g. `wormholesystems_map_sync_status`) using local state with **zero** upstream requests. Configuration/enrollment must be an explicit operator action through the existing authenticated control plane, or safe deployment configuration; no automatic enrollment from a user-supplied key in source records. Never echo secret arguments, payloads containing secrets, or raw upstream error bodies. A successful source fetch alone does not authorize note writes; unit 02 owns them.

## Required behavior and interfaces

The source adapter's internal API should yield `{ sourceIdentity, revisionOrDigest, fetchedAt, observedAt?, systems, connections, signatures, authorityMetadata }`, with typed stable IDs and explicit validity flags. IDs are opaque strings except verified EVE solar-system IDs; keep raw source and Nexum object IDs distinct. Directional identity is `(scannerEveSystemId, signatureCode, sourceSignatureId if provided)` and the connection identity must distinguish concurrent links. For matching, the normalized data must carry endpoint EVE system IDs, both directions when known, source connection ID, active/broken/expired/unknown state, and source observation/freshness evidence. If upstream cannot supply some of these, mark the associated match ineligible; do not fill gaps by guessing.

Sync is serialized per enabled canonical map. A disabled or different map must never fetch, stage, or write under this integration. On fetch/parse/auth/rate-limit failure, retain last good snapshot for labeled read-only diagnostics, mark it **ineligible for new writes**, and do not silently substitute old chain plans. A newer successfully validated snapshot supersedes the old one atomically; reject older revisions/observation times when order is verifiable, otherwise require a deterministic digest and record that ordering is unknown. Do not delete data in Nexum on source disappearance.

Bound requests: explicit connect/response timeout and abort on shutdown; one in-flight sync per target map, no unbounded fan-out or retry storm; exponential backoff with jitter for transient errors and honor `Retry-After` for 429/503 (seconds and HTTP date). 401/403 require operator correction, not immediate retry. Do not implement scheduled polling, webhook listeners, subscriptions, or upstream mutations until the deployed service supports a documented contract. Ordinary Nexum/chain reads continue to use local data only.

## Validation

Fixture-first tests for adapter normalization, missing fields, unsafe IDs, duplicate/directional identities, conflicting revisions, out-of-order responses, bounded timeouts/backoff, Retry-After, auth failures, atomic replacement, restart persistence, stale snapshot read-only behavior, secret redaction, one-map isolation, and zero upstream calls for preview/read. Fake HTTP transport only; no live keys or production service calls. `npm run build` and `npx vitest run` must pass.

## Out of scope

Live rollout, source writes, schedule/webhook invention, Nexum signature matching/writes (unit 02), topology mutation, user-facing bookmark-spec invention.

## Open issue — upstream adapter and deployment

Obtain the **current, supersession-resolved** WormholeSystems authority records and the actual deployment's documented read endpoint, response/version schema, identity/auth scheme and approved origin, data freshness semantics, rate limits, and allowed request cadence. Confirm target canonical Nexum map ID and the credential/operator authorization path. These are required to activate a production adapter; until then ship only fixture-driven behavior with integration **disabled**. Do not use any supplied key against live services during this design or testing.
