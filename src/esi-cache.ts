import { getStateDatabase } from "./persistence.js";
import { claimUpstreamAttempt,isBackground } from "./work-priority.js";

export interface CacheMetadata {
  esiPages: number; esiFetchedAt: string; esiDate: string | null;
  esiLastModified: string | null; esiExpiresAt: string | null; esiETag: string | null;
  esiCacheControl: string | null; esiAge: string | null; localCacheExpiresAt: string | null;
  cacheStatus: "esi_response" | "local_hit" | "revalidated" | "stale_on_error";
  staleReason?: string; retryAt?: string; semanticStalenessNote?: string;
}
type Entry = { data: unknown; metadata: CacheMetadata; expiresAt: number; storedAt: number };
const inflight = new Map<string, Promise<{ data: unknown; metadata: CacheMetadata }>>();
/** Local-only view of the same cache identity and safety gates used by reads. */
export function inspectEsiCache(key: string, url: string) {
  const row = getStateDatabase().prepare(`SELECT expires_at AS expiresAt,
    json_extract(entry,'$.metadata.esiPages') AS pages,
    json_extract(entry,'$.metadata.localCacheExpiresAt') AS freshness
    FROM esi_cache WHERE cache_key=?`).get(key) as {expiresAt:number;pages:number;freshness:string|null} | undefined;
  const retryAt = Math.max(backoffUntil("global"),backoffUntil(`transport:${url}`),backoffUntil(`cache:${key}`));
  return { exists:!!row, expiresAt:row?.expiresAt ?? null, pages:row?.pages ?? 1,
    hasFreshness:!!row?.freshness, retryAt, inflight:inflight.has(key) };
}
export class EsiUnavailable extends Error {
  constructor(message: string, public retryAt: number) { super(message); }
}
export function backoffUntil(key: string): number {
  return (getStateDatabase().prepare("SELECT until_ms FROM esi_backoff WHERE key = ?").get(key) as { until_ms: number } | undefined)?.until_ms ?? 0;
}
export function setBackoff(key: string, until: number): void {
  getStateDatabase().prepare("INSERT INTO esi_backoff VALUES (?,?) ON CONFLICT(key) DO UPDATE SET until_ms = max(until_ms,excluded.until_ms)").run(key, until);
}
export async function disciplinedFetch(url: string, init: RequestInit): Promise<Response> {
  const key = `transport:${url}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const blocked = Math.max(backoffUntil("global"), backoffUntil(key));
    if (blocked > Date.now()) throw new EsiUnavailable("ESI rate limited/backoff; no upstream request made", blocked);
    claimUpstreamAttempt();
    let response: Response;
    try { response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30000) }); }
    catch (error) {
      const until = Date.now() + 30000 + Math.random() * 5000;
      setBackoff(key, until);
      throw new EsiUnavailable(`ESI network failure: ${error instanceof Error ? error.message : String(error)}`, until);
    }
    const h = response.headers;
    const remain = Number(h.get("x-esi-error-limit-remain") ?? Infinity);
    const resetMs = Math.max(1000, Number(h.get("x-esi-error-limit-reset") ?? 60) * 1000);
    if (remain < 20) {
      setBackoff("global", Date.now() + resetMs);
      process.stderr.write(`ESI error limit warning: ${remain} errors remaining; pausing upstream calls\n`);
    }
    const retry = h.get("retry-after");
    const retryMs = retry === null ? 0 : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
    if (response.status === 420 || response.status === 429 || response.status >= 500) {
      const delay = Math.max(Number.isFinite(retryMs) ? retryMs : 0,
        response.status === 420 ? resetMs : response.status === 429 ? 60000 : 1000 * 2 ** attempt) + Math.random() * 1000;
      const until = Date.now() + delay;
      // Conservative global circuit breaker for rate limits (also covers endpoint buckets).
      setBackoff(response.status === 420 || response.status === 429 ? "global" : key, until);
      // Never automatically repeat writes; retry only idempotent GETs, with bounded waits.
      if (!isBackground() && (init.method ?? "GET") === "GET" && response.status >= 500 && attempt < 2 && delay < 5000 && remain >= 20) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, Math.ceil(delay)));
        continue;
      }
      await response.body?.cancel();
      const cooldown = Math.max(until, Date.now() + 30000);
      setBackoff(key, cooldown);
      throw new EsiUnavailable(`ESI rate limited/unavailable (${response.status}); reset ${resetMs / 1000} seconds; retry no earlier than ${new Date(cooldown).toISOString()}`, cooldown);
    }
    return response;
  }
  throw new Error("Unreachable retry state");
}

/** forceRefresh never shortens upstream freshness or a failure cooldown. */
export async function cachedEsiGet<T>(key: string, endpoint: string, fetcher: (conditional: Record<string, string>) => Promise<Response>,
  options: { forceRefresh?: boolean; allowStale?: boolean } = {}): Promise<{ data: T; metadata: CacheMetadata }> {
  const db = getStateDatabase();
  const row = db.prepare("SELECT entry FROM esi_cache WHERE cache_key = ?").get(key) as { entry: string } | undefined;
  const cached: Entry | undefined = row ? JSON.parse(row.entry) : undefined;
  if (cached && cached.expiresAt > Date.now()) return { data: structuredClone(cached.data) as T, metadata: { ...cached.metadata, cacheStatus: "local_hit" } };
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const cooldown = backoffUntil(`cache:${key}`);
      if (cooldown > Date.now()) throw new EsiUnavailable("ESI cache refresh cooling down", cooldown);
      const conditional: Record<string, string> = {};
      if (cached?.metadata.esiETag) conditional["If-None-Match"] = cached.metadata.esiETag;
      else if (cached?.metadata.esiLastModified) conditional["If-Modified-Since"] = cached.metadata.esiLastModified;
      const start = Date.now();
      const response = await fetcher(conditional);
      if (!response.ok && response.status !== 304) {
        // Authentication/permission/not-found errors never permit stale fallback.
        db.prepare("DELETE FROM esi_cache WHERE cache_key = ?").run(key);
        setBackoff(`cache:${key}`, Date.now() + 30000);
        throw new Error(`ESI ${endpoint} failed (${response.status}): ${await response.text()}`);
      }
      if (response.status === 304 && !cached) throw new Error("ESI returned 304 without a stored representation");
      const data = response.status === 304 ? cached!.data : await response.json();
      const now = Date.now();
      const h = response.headers;
      const control = h.get("cache-control") ?? (response.status === 304 ? cached!.metadata.esiCacheControl : null) ?? "";
      const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(control);
      const date = Date.parse(h.get("date") ?? "");
      const expires = Date.parse(h.get("expires") ?? "");
      const age = Math.max(0, Number(h.get("age") ?? 0) * 1000);
      const lifetime = maxAge ? Number(maxAge[1]) * 1000 : Number.isFinite(expires) ? expires - (Number.isFinite(date) ? date : now) : 0;
      const currentAge = Math.max(Number.isFinite(date) ? Math.max(0, now - date) : 0, age + now - start);
      const expiresAt = /(?:^|,)\s*(no-cache|no-store)\b/i.test(control) ? now : now + Math.max(0, lifetime - currentAge);
      const metadata: CacheMetadata = {
        esiPages: Math.max(1, parseInt(h.get("x-pages") ?? String(response.status === 304 ? cached!.metadata.esiPages : 1), 10) || 1),
        esiFetchedAt: new Date(now).toISOString(), esiDate: h.get("date"), esiExpiresAt: h.get("expires"),
        esiLastModified: h.get("last-modified") ?? (response.status === 304 ? cached!.metadata.esiLastModified : null),
        esiETag: h.get("etag") ?? (response.status === 304 ? cached!.metadata.esiETag : null),
        esiCacheControl: control || null, esiAge: h.get("age"),
        localCacheExpiresAt: expiresAt > now ? new Date(expiresAt).toISOString() : null,
        cacheStatus: response.status === 304 ? "revalidated" : "esi_response",
        ...(/\/planets\//.test(endpoint) ? { semanticStalenessNote: "PI can remain semantically stale until the colony is viewed/interacted with in-client. Polling harder does not fix this." } : {}),
      };
      if (/\bno-store\b/i.test(control)) db.prepare("DELETE FROM esi_cache WHERE cache_key = ?").run(key);
      else {
        db.prepare("INSERT OR REPLACE INTO esi_cache VALUES (?,?,?,?)").run(key, endpoint, expiresAt, JSON.stringify({ data, metadata, expiresAt, storedAt: now }));
        // Bound hot-cache storage without touching ledger history.
        db.prepare("DELETE FROM esi_cache WHERE cache_key IN (SELECT cache_key FROM esi_cache ORDER BY expires_at DESC LIMIT -1 OFFSET 5000)").run();
      }
      return { data, metadata };
    })();
    inflight.set(key, pending);
    void pending.finally(() => inflight.delete(key)).catch(() => {});
  }
  try { return structuredClone(await pending) as { data: T; metadata: CacheMetadata }; }
  catch (error) {
    if (error instanceof EsiUnavailable) {
      setBackoff(`cache:${key}`, error.retryAt);
      if (options.allowStale && cached && Date.now() - cached.storedAt <= 86400000 &&
          !/\b(no-cache|no-store|must-revalidate)\b/i.test(cached.metadata.esiCacheControl ?? "")) {
        return { data: structuredClone(cached.data) as T, metadata: { ...cached.metadata, cacheStatus: "stale_on_error", staleReason: error.message, retryAt: new Date(error.retryAt).toISOString() } };
      }
    }
    throw error;
  }
}
