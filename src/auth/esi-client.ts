import fs from "fs";
import { parseEsiJson } from "../esi-json.js";
import path from "path";
import os from "os";
import { refreshAccessToken } from "./oauth.js";
import { getCurrentCharacter, updateTokens, getTokens } from "./tokens.js";
import type { StoredCharacter } from "./tokens.js";
import { createHash } from "crypto";
import { cachedEsiGet, disciplinedFetch, type CacheMetadata } from "../esi-cache.js";
import { isBackground, WarmDeferred } from "../work-priority.js";
import { observeEsiRead, observeReadCharacter } from "../esi-related.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const tokenRefreshes = new Map<number, Promise<StoredCharacter>>();

export interface EsiRequestOptions {
  characterId?: number;
  public?: boolean;
  forceRefresh?: boolean;
  allowStale?: boolean;
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
      const id = character.characterId;
      let pending = tokenRefreshes.get(id);
      if (!pending) {
        const refreshToken = character.refreshToken;
        pending = (async () => {
          const newTokens = await refreshAccessToken(refreshToken, clientId);
          updateTokens(id, newTokens);
          return getTokens(id)!;
        })();
        tokenRefreshes.set(id,pending);
        void pending.finally(()=>tokenRefreshes.delete(id)).catch(()=>{});
      }
      character = await pending;
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
  return parseEsiJson(await response.text()) as T;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  esiPath: string
): Promise<Response> {
  return disciplinedFetch(url, init);
}

async function buildHeaders(opts?: EsiRequestOptions): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!opts?.public) {
    const { token } = await getValidToken(opts?.characterId);
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Local identity construction shared by read-through and keep-warm inspection. No SSO/ESI calls. */
export function esiCacheIdentity(esiPath: string, opts?: EsiRequestOptions): { key: string; url: string } {
  // Public callers share one key. Private keys contain no bearer/refresh tokens.
  const character = opts?.public ? null : opts?.characterId ? getTokens(opts.characterId) : getCurrentCharacter();
  const identity = opts?.public ? "public" : `${character?.characterId}:${character?.scopes.split(" ").sort().join(" ")}`;
  const url = new URL(`${ESI_BASE}${esiPath}`);
  url.searchParams.sort();
  const key = createHash("sha256").update(`${identity}:${url}`).digest("hex");
  return { key, url: `${ESI_BASE}${esiPath}` };
}

/** Cache only for the freshness lifetime supplied by ESI, never a fixed local TTL. */
export async function esiGetWithMetadata<T>(esiPath: string, opts?: EsiRequestOptions): Promise<{ data: T; metadata: CacheMetadata }> {
  const headers = await buildHeaders(opts); // Authenticate even when serving a cached response.
  const {key,url} = esiCacheIdentity(esiPath,opts);
  const read=()=>cachedEsiGet<T>(key, esiPath, conditional => fetchWithRetry(url, { headers: { ...headers, ...conditional } }, esiPath), opts);
  try {const result = await read(); observeEsiRead(esiPath); return result;}
  catch(error) {
    // A foreground caller that joined queued (not dispatched) warm work takes over.
    if(error instanceof WarmDeferred && !isBackground()) { const result = await read(); observeEsiRead(esiPath); return result; }
    throw error;
  }
}

export async function esiGet<T>(
  esiPath: string,
  opts?: EsiRequestOptions & { cacheTtlMs?: number }
): Promise<T> {
  // Legacy cacheTtlMs arguments are deliberately ignored: only ESI sets freshness.
  // Data-only callers cannot label stale results, so never silently serve stale here.
  return (await esiGetWithMetadata<T>(esiPath, { ...opts, allowStale: false })).data;
}

export async function esiGetAll<T>(
  esiPath: string,
  opts?: EsiRequestOptions & { cacheTtlMs?: number }
): Promise<T[]> {
  const first = await esiGetWithMetadata<T[]>(esiPath, { ...opts, allowStale: false });
  const allData = [...first.data];
  // Each page has its own upstream expiry; never assign a new aggregate TTL.
  // Bound concurrency to avoid flooding ESI for large corporate inventories.
  const concurrency = isBackground() ? 1 : 5;
  for (let start = 2; start <= first.metadata.esiPages; start += concurrency) {
    const pages: Promise<T[]>[] = [];
    for (let page = start; page < start + concurrency && page <= first.metadata.esiPages; page++) {
      pages.push(esiGet<T[]>(esiPagePath(esiPath,page), opts));
    }
    allData.push(...(await Promise.all(pages)).flat());
  }
  return allData;
}

// The dated route API is public and explicitly not cached by ESI.
export async function esiCalculateRoute(
  origin: number,
  destination: number,
  body: { preference: "Shorter" | "Safer" | "LessSecure"; security_penalty: number; avoid_systems: number[] }
): Promise<{ route: number[] }> {
  const esiPath = `/route/${origin}/${destination}`;
  const response = await fetchWithRetry(`https://esi.evetech.net${esiPath}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Compatibility-Date": "2025-09-30",
    },
    body: JSON.stringify(body),
  }, esiPath);
  const result = await handleResponse<{ route: number[] }>(response, esiPath);
  observeEsiRead(esiPath);
  return result;
}

export function esiPagePath(esiPath: string, page: number): string {
  if (page === 1) return esiPath;
  const url = new URL(`${ESI_BASE}${esiPath}`);
  url.searchParams.set("page",String(page));
  return url.pathname.replace(/^\/latest/, "") + url.search;
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
  observeEsiRead(esiPath);
  // Successful writes can change a previously cached representation.
  // Writes do not bypass an upstream cache's still-valid freshness window.
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
}

export async function getActiveCharacter(
  characterId?: number
): Promise<StoredCharacter> {
  const { character } = await getValidToken(characterId);
  observeReadCharacter(character.characterId);
  return character;
}
