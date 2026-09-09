import fs from "fs";
import path from "path";
import os from "os";
import { refreshAccessToken } from "./oauth.js";
import { getCurrentCharacter, updateTokens, getTokens } from "./tokens.js";
import type { StoredCharacter } from "./tokens.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export interface EsiRequestOptions {
  characterId?: number;
  public?: boolean;
}

export function readClientId(): string {
  const configPath = path.join(os.homedir(), ".eve-sde", "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      "No config.json found at ~/.eve-sde/config.json — run esi_login with a client_id first"
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return config.clientId;
}

export async function getValidToken(
  characterId?: number
): Promise<{ token: string; character: StoredCharacter }> {
  let character: StoredCharacter | null;
  if (characterId) {
    character = getTokens(characterId);
  } else {
    character = getCurrentCharacter();
  }

  if (!character) {
    throw new Error("No authenticated character. Use the esi_login tool first.");
  }

  const fiveMinutes = 5 * 60 * 1000;
  const timeLeft = character.expiresAt.getTime() - Date.now();
  if (timeLeft < fiveMinutes) {
    const expired = timeLeft <= 0;
    process.stderr.write(
      `ESI token for ${character.characterName} ${expired ? "expired" : "expiring soon"}, refreshing...\n`
    );
    const clientId = readClientId();
    try {
      const newTokens = await refreshAccessToken(character.refreshToken, clientId);
      updateTokens(character.characterId, newTokens);
      character = getTokens(character.characterId)!;
      process.stderr.write(`ESI token refreshed, valid for ${Math.round(newTokens.expiresAt.getTime() - Date.now()) / 1000}s\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Token refresh failed for ${character.characterName}: ${msg}. ` +
        `Use the esi_login tool to re-authenticate.`
      );
    }
  }

  return { token: character.accessToken, character };
}

function checkRateLimit(response: Response, esiPath: string): void {
  const remaining = response.headers.get("x-esi-error-limit-remain");
  if (remaining !== null && parseInt(remaining, 10) < 20) {
    const reset = response.headers.get("x-esi-error-limit-reset") ?? "?";
    process.stderr.write(
      `ESI error limit warning: ${remaining} errors remaining, resets in ${reset}s (${esiPath})\n`
    );
  }
}

async function handleResponse<T>(response: Response, esiPath: string): Promise<T> {
  checkRateLimit(response, esiPath);

  if (response.status === 420) {
    const reset = response.headers.get("x-esi-error-limit-reset") ?? "unknown";
    throw new Error(
      `ESI rate limited on ${esiPath}. Retry after ${reset} seconds.`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ESI ${esiPath} failed (${response.status}): ${body}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  esiPath: string
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_RETRIES) {
      return response;
    }
    process.stderr.write(
      `ESI ${response.status} on ${esiPath}, retry ${attempt + 1}/${MAX_RETRIES}...\n`
    );
    await sleep(RETRY_DELAY_MS * (attempt + 1));
  }
  return fetch(url, init);
}

async function buildHeaders(opts?: EsiRequestOptions): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!opts?.public) {
    const { token } = await getValidToken(opts?.characterId);
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

interface CacheMetadata {
  esiPages: number;
  esiFetchedAt: string;
  esiDate: string | null;
  esiLastModified: string | null;
  esiExpiresAt: string | null;
  esiETag: string | null;
  esiCacheControl: string | null;
  esiAge: string | null;
  localCacheExpiresAt: string | null;
  cacheStatus: "esi_response" | "local_hit";
}
const metadataCache = new Map<string, { data: unknown; metadata: CacheMetadata; expiresAt: number }>();

/** Cache only for the freshness lifetime supplied by ESI, never a fixed local TTL. */
export async function esiGetWithMetadata<T>(esiPath: string, opts?: EsiRequestOptions): Promise<{ data: T; metadata: CacheMetadata }> {
  const headers = await buildHeaders(opts); // Authenticate even when serving a cached response.
  const key = `${headers.Authorization ?? "public"}:${esiPath}`;
  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { data: structuredClone(cached.data) as T, metadata: { ...cached.metadata, cacheStatus: "local_hit" } };
  }
  metadataCache.delete(key);
  const startedAt = Date.now();
  const response = await fetchWithRetry(`${ESI_BASE}${esiPath}`, { headers }, esiPath);
  const data = await handleResponse<T>(response, esiPath);
  const now = Date.now();
  const h = response.headers;
  const control = h.get("cache-control") ?? "";
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(control);
  const date = Date.parse(h.get("date") ?? "");
  const expires = Date.parse(h.get("expires") ?? "");
  const age = Math.max(0, Number(h.get("age") ?? 0) * 1000);
  const lifetime = maxAge ? Number(maxAge[1]) * 1000 : Number.isFinite(expires) ? expires - (Number.isFinite(date) ? date : now) : 0;
  const currentAge = Math.max(Number.isFinite(date) ? Math.max(0, now - date) : 0, age + now - startedAt);
  const expiresAt = /(?:^|,)\s*(no-cache|no-store)\b/i.test(control) ? now : now + Math.max(0, lifetime - currentAge);
  const metadata: CacheMetadata = {
    esiPages: Math.max(1, parseInt(h.get("x-pages") ?? "1", 10) || 1),
    esiFetchedAt: new Date(now).toISOString(), esiDate: h.get("date"),
    esiLastModified: h.get("last-modified"), esiExpiresAt: h.get("expires"),
    esiETag: h.get("etag"), esiCacheControl: h.get("cache-control"), esiAge: h.get("age"),
    localCacheExpiresAt: expiresAt > now ? new Date(expiresAt).toISOString() : null,
    cacheStatus: "esi_response",
  };
  if (expiresAt > now) {
    if (metadataCache.size >= 256) metadataCache.delete(metadataCache.keys().next().value!);
    metadataCache.set(key, { data: structuredClone(data), metadata, expiresAt });
  }
  return { data, metadata };
}

export async function esiGet<T>(
  esiPath: string,
  opts?: EsiRequestOptions & { cacheTtlMs?: number }
): Promise<T> {
  // Legacy cacheTtlMs arguments are deliberately ignored: only ESI sets freshness.
  return (await esiGetWithMetadata<T>(esiPath, opts)).data;
}

export async function esiGetAll<T>(
  esiPath: string,
  opts?: EsiRequestOptions & { cacheTtlMs?: number }
): Promise<T[]> {
  const first = await esiGetWithMetadata<T[]>(esiPath, opts);
  const allData = [...first.data];
  // Each page has its own upstream expiry; never assign a new aggregate TTL.
  // Bound concurrency to avoid flooding ESI for large corporate inventories.
  for (let start = 2; start <= first.metadata.esiPages; start += 5) {
    const pages: Promise<T[]>[] = [];
    for (let page = start; page < start + 5 && page <= first.metadata.esiPages; page++) {
      const url = new URL(`${ESI_BASE}${esiPath}`);
      url.searchParams.set("page", String(page));
      pages.push(esiGet<T[]>(url.pathname.replace(/^\/latest/, "") + url.search, opts));
    }
    allData.push(...(await Promise.all(pages)).flat());
  }
  return allData;
}

export async function esiPost<T>(
  esiPath: string,
  body: unknown,
  opts?: EsiRequestOptions
): Promise<T> {
  const url = `${ESI_BASE}${esiPath}`;
  const { token } = await getValidToken(opts?.characterId);

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  }, esiPath);

  const result = await handleResponse<T>(response, esiPath);
  // Successful writes can change a previously cached representation.
  if (esiPath.startsWith("/ui/") || /\/fittings\//.test(esiPath)) metadataCache.clear();
  return result;
}

export async function esiDelete(
  esiPath: string,
  opts?: EsiRequestOptions
): Promise<void> {
  const url = `${ESI_BASE}${esiPath}`;
  const { token } = await getValidToken(opts?.characterId);

  const response = await fetchWithRetry(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  }, esiPath);

  await handleResponse<void>(response, esiPath);
  metadataCache.clear();
}

export async function getActiveCharacter(
  characterId?: number
): Promise<StoredCharacter> {
  const { character } = await getValidToken(characterId);
  return character;
}
