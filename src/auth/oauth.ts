import { CORPORATION_SCOPES } from "../corporation-endpoints.js";
import crypto from "crypto";
import http from "http";
import { URL } from "url";
import { escapeHtml } from "../utils.js";

const EVE_SSO_BASE = "https://login.eveonline.com";
const EVE_AUTHORIZE_URL = `${EVE_SSO_BASE}/v2/oauth/authorize`;
const EVE_TOKEN_URL = `${EVE_SSO_BASE}/v2/oauth/token`;

const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_SCOPES = [
  ...CORPORATION_SCOPES,
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
  "esi-wallet.read_character_wallet.v1",
  "esi-markets.read_character_orders.v1",
  "esi-markets.structure_markets.v1",
  "esi-industry.read_character_jobs.v1",
  "esi-assets.read_assets.v1",
  "esi-assets.read_corporation_assets.v1",
  "esi-contracts.read_character_contracts.v1",
  "esi-fittings.read_fittings.v1",
  "esi-fittings.write_fittings.v1",
  "esi-killmails.read_killmails.v1",
  "esi-characters.read_loyalty.v1",
  "esi-ui.write_waypoint.v1",
  "esi-planets.manage_planets.v1",
  "esi-location.read_location.v1",
  "esi-location.read_ship_type.v1",
  "esi-clones.read_clones.v1",
  "esi-clones.read_implants.v1",
  "esi-industry.read_character_mining.v1",
  "esi-characters.read_blueprints.v1",
  "esi-characters.read_standings.v1",
  "esi-characters.read_notifications.v1",
  "esi-characters.read_corporation_roles.v1",
  "esi-wallet.read_corporation_wallets.v1",
  "esi-corporations.read_blueprints.v1",
  "esi-industry.read_corporation_jobs.v1",
  "esi-corporations.read_structures.v1",
  "esi-universe.read_structures.v1",
];

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface CharacterInfo {
  characterId: number;
  characterName: string;
  scopes: string;
}

export interface CallbackConfig {
  /** Full callback URL sent to EVE SSO as redirect_uri (auth + token exchange). */
  url: string;
  /** Path portion of the callback URL (route on the main HTTP server when configured). */
  path: string;
  /** True when the URL comes from EVE_SSO_CALLBACK_URL; false for the local default. */
  explicit: boolean;
}

/**
 * Resolve the OAuth callback target.
 *
 * - `EVE_SSO_CALLBACK_URL` (e.g. `https://galaxy.example.net/callback`): the
 *   publicly reachable URL registered with EVE SSO. The callback is served by
 *   the main HTTP server on this path, so no extra port is exposed — required
 *   for deployments behind k3s/Traefik or any public HTTPS ingress.
 * - Unset (local development): `http://localhost:8085/callback`, served by a
 *   dedicated in-process listener, preserving the original behavior.
 */
export function getCallbackConfig(): CallbackConfig {
  const raw = (process.env.EVE_SSO_CALLBACK_URL ?? "").trim();
  if (!raw) {
    return { url: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`, path: CALLBACK_PATH, explicit: false };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`EVE_SSO_CALLBACK_URL must be an absolute URL, got: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`EVE_SSO_CALLBACK_URL must use http(s), got: ${parsed.protocol}`);
  }
  if (parsed.pathname === "/") {
    throw new Error(`EVE_SSO_CALLBACK_URL must include a callback path (e.g. ${raw}/callback)`);
  }
  parsed.search = "";
  parsed.hash = "";
  return { url: parsed.toString(), path: parsed.pathname, explicit: true };
}

export interface AuthResult {
  tokens: OAuthTokens;
  character: CharacterInfo;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface PendingFlow {
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  resolve: (result: AuthResult) => void;
  reject: (err: Error) => void;
  server: http.Server | null;
  timeout: ReturnType<typeof setTimeout>;
}

let pendingFlow: PendingFlow | null = null;
let pendingPromise: Promise<AuthResult> | null = null;

export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  scopes: string[],
  challenge: string,
  state: string
): string {
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    client_id: clientId,
    scope: scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${EVE_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Handle an incoming OAuth callback (EVE SSO redirect). Shared by the
 * dedicated local listener (default) and the main HTTP server route
 * (EVE_SSO_CALLBACK_URL). Validates state, exchanges the code, and settles
 * the pending login flow.
 */
export function handleOAuthCallback(rawUrl: string, respond: (status: number, html: string) => void): void {
  const flow = pendingFlow;
  if (!flow) {
    respond(
      400,
      "<h1>Authentication Failed</h1><p>No login in progress. Start a login with esi_login first.</p>"
    );
    return;
  }

  let url: URL;
  try {
    url = new URL(rawUrl, flow.redirectUri);
  } catch {
    respond(400, "<h1>Authentication Failed</h1><p>Malformed callback request</p>");
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    respond(400, `<h1>Authentication Failed</h1><p>${escapeHtml(error)}</p>`);
    flow.reject(new Error(`OAuth error: ${error}`));
    cleanupFlow();
    return;
  }

  if (returnedState !== flow.state) {
    respond(400, "<h1>Authentication Failed</h1><p>Invalid state parameter</p>");
    flow.reject(new Error("Invalid state — possible CSRF"));
    cleanupFlow();
    return;
  }

  if (!code) {
    respond(400, "<h1>Authentication Failed</h1><p>No authorization code</p>");
    flow.reject(new Error("No authorization code received"));
    cleanupFlow();
    return;
  }

  void (async () => {
    try {
      const tokens = await exchangeCode(code, flow.clientId, flow.redirectUri, flow.verifier);
      const character = decodeCharacterFromJwt(tokens.accessToken);
      respond(
        200,
        `<h1>Authentication Successful!</h1><p>Logged in as <strong>${escapeHtml(character.characterName)}</strong>. You can close this tab.</p>`
      );
      flow.resolve({
        tokens,
        character: { ...character, scopes: flow.scopes },
      });
    } catch (err) {
      respond(500, "<h1>Authentication Failed</h1><p>Token exchange error</p>");
      flow.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      cleanupFlow();
    }
  })();
}

function cleanupFlow(): void {
  const flow = pendingFlow;
  if (!flow) return;
  clearTimeout(flow.timeout);
  flow.server?.close();
  pendingFlow = null;
  pendingPromise = null;
}

export function startLoginFlow(clientId: string, scopes?: string[]): { authUrl: string } {
  if (pendingFlow) {
    const previous = pendingFlow;
    cleanupFlow();
    previous.reject(new Error("Login flow superseded by new login attempt"));
  }

  const callback = getCallbackConfig();
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = callback.url;
  const selectedScopes = [...new Set(scopes ?? DEFAULT_SCOPES)];

  const authUrl = buildAuthorizeUrl(clientId, redirectUri, selectedScopes, challenge, state);

  pendingPromise = new Promise<AuthResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Login timed out after 5 minutes. Start a new login with esi_login."));
      cleanupFlow();
    }, LOGIN_TIMEOUT_MS);

    const flow: PendingFlow = {
      verifier,
      state,
      clientId,
      redirectUri,
      scopes: selectedScopes.join(" "),
      resolve,
      reject,
      server: null,
      timeout,
    };
    pendingFlow = flow;

    if (callback.explicit) {
      // Public callback: the main HTTP server serves this path (see src/http.ts),
      // so no extra listener is opened and no extra port needs to be exposed.
      process.stderr.write(`OAuth callback will be served by the main HTTP server at ${redirectUri}\n`);
      return;
    }

    // Local development default: dedicated in-process listener on localhost.
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith(callback.path)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      handleOAuthCallback(req.url, (status, html) => {
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end(html);
      });
    });
    flow.server = server;

    server.listen(CALLBACK_PORT, () => {
      process.stderr.write(`OAuth callback server listening on ${redirectUri}\n`);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${CALLBACK_PORT} is already in use`));
      } else {
        reject(err);
      }
      pendingFlow = null;
      pendingPromise = null;
    });
  });

  return { authUrl };
}

export async function waitForLogin(): Promise<AuthResult> {
  if (!pendingPromise) {
    throw new Error("No login flow in progress. Call esi_login first.");
  }
  return pendingPromise;
}

async function exchangeCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): Promise<OAuthTokens> {
  const response = await fetch(EVE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Host: "login.eveonline.com",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string
): Promise<OAuthTokens> {
  const response = await fetch(EVE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Host: "login.eveonline.com",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

function decodeCharacterFromJwt(accessToken: string): {
  characterId: number;
  characterName: string;
} {
  const parts = accessToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");

  const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));

  const sub = payload.sub as string;
  const match = sub.match(/CHARACTER:EVE:(\d+)/);
  if (!match) throw new Error(`Unexpected JWT sub format: ${sub}`);

  return {
    characterId: parseInt(match[1], 10),
    characterName: payload.name as string,
  };
}
