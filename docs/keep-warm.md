# Galaxy refresh-on-idle cache warming

Primary brief: `wormlife-trial/05 Planning/Galaxy Keep-Warm Cache Design.md`, read in full before coding. This feature changes Galaxy only. No Obsidian code, configuration, notes, or service changes are required.

## Architecture

- `esi-datasets.ts`: internal logical dataset registry, strict parameter validation, required scopes, explicit pagination mode, and path builders shared with foreground tools.
- `keep-warm.ts`: persistent enrollment/status, local cache eligibility inspection, and bounded idle passes.
- `work-priority.ts`: foreground activity/grace tracking and an async-context upstream work budget.
- `tools/keep-warm.ts`: four generic MCP tools.
- Existing `auth/esi-client.ts` / `esi-cache.ts`: shared cache identities, page paths, read-through requests, validators, coalescing, timeout, auth, and backoff. No alternative HTTP/cache client exists.
- HTTP and stdio entry points start/stop housekeeping; central MCP callback tracking covers both transports. HTTP request tracking also covers work outside callbacks.

`galaxy-state.db` gains `keep_warm_subscriptions`: UUID, dataset, subject key, canonical JSON params, enabled, timestamps, status/error, and a stable 1–5s positive jitter. `(dataset,subject_key,params_json)` is unique. Repeated enrollment updates the existing subscription and resets blocked status; it does not discard success history. No bearer tokens are stored. The existing `esi_cache` remains the only cached representation. No automatic enrollment or historical data import occurs.

## MCP API

### `keep_warm_dataset`

```ts
{
  dataset: string,       // registered logical name, not URL
  subject_key: string,   // character/corporation numeric ID for initial adapters
  params?: object,       // default {}; adapter-validated, unknown keys rejected
  enabled?: boolean     // default true; true also resets blocked status
}
```

### `remove_keep_warm_dataset`

```ts
{ id: string }
```

Removes only enrollment. Existing ESI cache is retained. An upstream request already dispatched may finish; queued work and subsequent pages check enrollment again before dispatch.

### `list_keep_warm_datasets`

```ts
{ limit?: number, offset?: number } // default 100/0; maximum limit 200
```

Returns subscriptions plus `nextOffset`. Each includes identity, parameters, enabled/status, cache status, expiry/next eligibility when known, last considered/attempt/full-success timestamps, and last error. Inspection performs local reads only—no token refresh or ESI calls.

### `list_keep_warm_dataset_types`

```ts
{}
```

Returns supported names, descriptions, subject meaning, parameter JSON schemas and required OAuth scopes. Support is not enrollment.

## Initial adapters

| Dataset | Subject | Params | Underlying semantics |
| --- | --- | --- | --- |
| `character_assets` | Character ID | `{}` | All asset pages, `esi-assets.read_assets.v1` |
| `corporation_assets` | Corporation ID | `{character_id: positive integer}` | All corporation asset pages; `esi-assets.read_corporation_assets.v1`; ESI enforces Director/role access |
| `wallet_journal` | Character ID | `{}` | Existing all-page journal read, `esi-wallet.read_character_wallet.v1` |
| `wallet_transactions` | Character ID | `{}` | Existing recent transaction response, no historical cursor crawl; wallet scope |
| `industry_jobs` | Character ID | `{include_completed?: boolean}` (false) | Existing single response and include-completed query; `esi-industry.read_character_jobs.v1` |

Client-side name/type/date filters are not subscriptions: warming targets the shared source representation. PI, location, markets, skills and other feeds are not enrolled or registered by this change. Actual character/corporation subscriptions should be configured separately through these tools; none are hard-coded.

## Idle scheduler and safety

Housekeeping starts without fetching anything. A 30-second unreferenced timer invokes a local pass. It is a local inspection cadence, **not an ESI polling TTL**. Idle means zero active foreground requests and at least five seconds since the last foreground completion. At most 100 subscriptions are considered in a pass, in least-recently-considered order for fairness. At most one logical refresh is attempted, with **one upstream HTTP attempt total** and no concurrent warm passes.

Eligibility uses the existing cache identity, page expiry, in-flight state, global/endpoint/key cooldowns, and positive jitter. Fresh entries never refresh early. Jitter only delays eligibility. Cooldowns are checked again by the existing ESI client immediately before dispatch. Normal auth/token refresh is used only when a candidate is eligible; ordinary inspection never attempts SSO.

Background pagination uses the existing `esiGetAll` page construction, but serially. When the one-attempt budget runs out it yields with `deferred` status. Next idle pass walks fresh pages locally and advances the next expired page. `last_refresh_success_at` updates only when the complete logical read succeeds. Large datasets may take multiple passes; no shortened aggregate TTL, duplicate page cache, alternative result model, or special history crawl is introduced. Foreground pagination keeps its original concurrency and result shape.

Foreground activity, subscription removal/disable, and scheduler shutdown are checked before every background upstream dispatch. An in-flight request is allowed to finish and can be shared with a foreground caller through the same single-flight cache. A foreground caller joining queued work that was deferred takes over through the existing read path. Background 5xx errors use the existing final cooldown path instead of spending another upstream attempt on a retry; foreground retry behavior is unchanged.

Missing auth/scopes, 401/403, removed definitions, invalid parameters, and non-transient errors become inspectable blocked statuses. Blocked subscriptions require explicit re-enrollment after repair; they do not repeatedly attempt auth. Transient availability/rate-limit failures use the existing persistent backoff. No immediate retry loop, auto-enrollment, or foreground `force_refresh` override is used.

## Conservative deviations

1. **Cold baseline:** subscriptions without the first cached page wait in `awaiting_cache` until a foreground read seeds the resource. This avoids turning restart/new enrollment into cold-fetch work with unknown upstream timing.
2. **No freshness evidence:** cached responses without usable successful freshness (including no-cache/no-store situations) are not repeatedly warmed. They remain ordinary foreground read-through resources, reported as `awaiting_freshness` or `awaiting_cache`.
3. **Stricter budget:** one upstream *attempt*, not a potentially many-page dataset refresh, per pass. This sacrifices immediate full-dataset freshness to keep the work budget genuinely small. No-active-job auto-suspension is deferred as optional in the brief.
4. The supported deployment remains a single Galaxy worker. Foreground tracking and refresh coalescing are process-local, as in the existing cache; this is not a distributed scheduler.

## Adding another dataset

Register a `DatasetDefinition` in `esi-datasets.ts` (or an imported adapter module): name, description, subject meaning, strict Zod params, required scopes, and `build(subject,params)` returning the established ESI path/options plus `pagination: "single" | "all"`. Reuse a foreground path builder and confirm its completeness/cache semantics. Do not expose a URL parameter. Add adapter/path/auth tests. The generic scheduler, SQLite schema, and four MCP tools do not change; discovery exposes the new definition automatically. Enrollment remains an explicit runtime decision.

## Verification

Tests cover persistence/reopen, fresh and expired states, positive jitter, global/endpoint/key cooldowns and Retry-After, foreground grace/preemption, foreground/background coalescing, per-page progress, bounded concurrent passes, startup, fairness, blocked auth/errors, disabled/removal behavior, extensibility, strict params, and the MCP lifecycle. Existing ESI cache-safety tests remain unchanged.
