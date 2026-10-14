/** Bounded, replaceable, read-only client for the self-hosted source API. */
export type WormholeSystemsConfig = {
  origin: string;
  apiPathPrefix: string;
  mapRouteKey: "id" | "slug";
};

export type ApiMapRecord = { id: string; slug: string | null };
export type WormholeSystemsTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class WormholeSystemsError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number, message: string) { super(message); }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const safeRouteId = (value: string): boolean => !!value && value.length <= 256 && value.trim() === value && value !== "." && value !== ".." &&
  !/[\/\\?#%\u0000-\u001f\u007f]/.test(value);

export function validateWormholeSystemsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/"))
    throw new WormholeSystemsError(0, 0, "WormholeSystems origin must be HTTPS without credentials, path, query or fragment");
  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  if (!host || (!host.startsWith("[") && (!/^[a-z0-9.-]+$/.test(host) || labels.some(label => !label || label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || host.length > 253)))
    throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems origin host");
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
  if (!authority || authority.includes("@") || authority.includes("%")) throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems origin authority");
  const rawHost = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0];
  const rawPort = authority.slice(rawHost.length);
  if (rawHost.toLowerCase() !== host || (rawPort && !/^:\d+$/.test(rawPort)))
    throw new WormholeSystemsError(0, 0, "Ambiguous WormholeSystems origin host or port");
  return url.origin;
}

export function validateWormholeSystemsPathPrefix(value: string): string {
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("/") || value.startsWith("//") || value.endsWith("/") ||
      value.includes("?") || value.includes("#") || value.includes("\\") || /%(?:2e|2f|5c)/i.test(value) ||
      value.slice(1).split("/").some(part => !part || part === "." || part === "..") || !/^\/[A-Za-z0-9._~/-]+$/.test(value))
    throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems API path prefix");
  return value;
}

function retryAfterMs(response: Response, now: number): number {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const parsed = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, Number.MAX_SAFE_INTEGER)) : 0;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new WormholeSystemsError(0, 0, "WormholeSystems response exceeded the size limit");
  }
  if (!response.body) throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new WormholeSystemsError(0, 0, "WormholeSystems response exceeded the size limit");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))); }
  catch { throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems response"); }
}

export class WormholeSystemsClient {
  private readonly origin: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(
    private readonly config: WormholeSystemsConfig,
    private readonly bearer: string,
    private readonly transport: WormholeSystemsTransport = fetch,
    private readonly options: { timeoutMs?: number; maxBytes?: number; maxAttempts?: number; now?: () => number; random?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.origin = validateWormholeSystemsOrigin(config.origin);
    this.prefix = validateWormholeSystemsPathPrefix(config.apiPathPrefix);
    if (!bearer || bearer.length > 4096 || /[\r\n]/.test(bearer)) throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems credential");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 1_000_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000 || !Number.isInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > 2_000_000)
      throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems request bounds");
  }

  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms);
    if (signal?.aborted) throw new WormholeSystemsError(0, 0, "WormholeSystems request aborted");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done() { signal?.removeEventListener("abort", abort); resolve(); }
      function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new WormholeSystemsError(0, 0, "WormholeSystems request aborted")); }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#") || path.includes("\\"))
      throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems resource path");
    const url = new URL(`${this.prefix}${path}`, `${this.origin}/`);
    if (url.origin !== this.origin || !url.pathname.startsWith(`${this.prefix}/`))
      throw new WormholeSystemsError(0, 0, "WormholeSystems request origin mismatch");
    const attempts = Math.max(1, Math.min(3, Math.floor(this.options.maxAttempts ?? 3)));
    for (let attempt = 0; ; attempt++) {
      const controller = AbortSignal.timeout(this.timeoutMs);
      try {
        const response = await this.transport(url, {
          method: "GET", redirect: "error", signal: signal ? AbortSignal.any([signal, controller]) : controller,
          headers: { Authorization: `Bearer ${this.bearer}`, Accept: "application/json" },
        });
        if (!response.ok) {
          const delay = retryAfterMs(response, (this.options.now ?? Date.now)());
          await response.body?.cancel();
          const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
          if (retryable && attempt + 1 < attempts && delay <= 30_000) {
            const backoff = delay || Math.min(5_000, 250 * 2 ** attempt) + Math.floor((this.options.random ?? Math.random)() * 100);
            await this.wait(backoff, signal);
            continue;
          }
          throw new WormholeSystemsError(response.status, delay, `WormholeSystems HTTP ${response.status}`);
        }
        return await readBoundedJson(response, this.maxBytes);
      } catch (error) {
        if (error instanceof WormholeSystemsError) throw error;
        if (signal?.aborted) throw new WormholeSystemsError(0, 0, "WormholeSystems request aborted");
        if (attempt + 1 >= attempts) throw new WormholeSystemsError(0, 0, "WormholeSystems request failed or timed out");
        await this.wait(Math.min(5_000, 250 * 2 ** attempt) + Math.floor((this.options.random ?? Math.random)() * 100), signal);
      }
    }
  }

  async listMaps(signal?: AbortSignal): Promise<ApiMapRecord[]> {
    const result = await this.get("/maps", signal);
    if (!record(result) || !Array.isArray(result.data) || result.data.length > 500 || result.data.some(row => !record(row) ||
      ((typeof row.id !== "string" || !row.id.trim() || row.id.length > 256 || /[\u0000-\u001f\u007f]/.test(row.id)) && !(typeof row.id === "number" && Number.isSafeInteger(row.id))) ||
      (row.slug !== undefined && row.slug !== null && (typeof row.slug !== "string" || !row.slug.trim() || row.slug.length > 256 || /[\u0000-\u001f\u007f]/.test(row.slug)))))
      throw new WormholeSystemsError(0, 0, "Malformed WormholeSystems maps response");
    return result.data.map(row => ({ id: String((row as Record<string, unknown>).id), slug: typeof (row as Record<string, unknown>).slug === "string" ? (row as Record<string, unknown>).slug as string : null }));
  }

  async mapDetail(apiMapId: string, signal?: AbortSignal): Promise<unknown> {
    if (!safeRouteId(apiMapId)) throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems map selection");
    const result = await this.get(`/maps/${encodeURIComponent(apiMapId)}`, signal);
    const body = record(result) ? result.data : undefined;
    if (!record(body) || (typeof body.id !== "string" && !(typeof body.id === "number" && Number.isSafeInteger(body.id))) || String(body.id) !== apiMapId)
      throw new WormholeSystemsError(0, 0, "WormholeSystems map detail identity mismatch");
    return body;
  }

  async solarSystemDetail(mapSolarSystemId: string, signal?: AbortSignal): Promise<unknown> {
    if (!safeRouteId(mapSolarSystemId)) throw new WormholeSystemsError(0, 0, "Invalid WormholeSystems solar-system selection");
    return this.get(`/map-solarsystems/${encodeURIComponent(mapSolarSystemId)}`, signal);
  }
}
