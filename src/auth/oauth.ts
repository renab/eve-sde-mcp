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
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
  "esi-wallet.read_character_wallet.v1",
  "esi-markets.read_character_orders.v1",
  "esi-markets.structure_markets.v1",
  "esi-industry.read_character_jobs.v1",
  "esi-assets.read_assets.v1",
  "esi-contracts.read_character_contracts.v1",
  "esi-fittings.read_fittings.v1",
  "esi-fittings.write_fittings.v1",
  "esi-killmails.read_killmails.v1",
  "esi-characters.read_loyalty.v1",
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

let pendingFlow: {
  verifier: string;
  state: string;
  clientId: string;
  resolve: (result: AuthResult) => void;
  reject: (err: Error) => void;
  server: http.Server;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;

let pendingPromise: Promise<AuthResult> | null = null;

export function startLoginFlow(clientId: string, scopes?: string[]): { authUrl: string } {
  if (pendingFlow) {
    clearTimeout(pendingFlow.timeout);
    pendingFlow.server.close();
    pendingFlow.reject(new Error("Login flow superseded by new login attempt"));
    pendingFlow = null;
    pendingPromise = null;
  }

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const selectedScopes = scopes ?? DEFAULT_SCOPES;

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    client_id: clientId,
    scope: selectedScopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  const authUrl = `${EVE_AUTHORIZE_URL}?${params.toString()}`;

  pendingPromise = new Promise<AuthResult>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith(CALLBACK_PATH)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authentication Failed</h1><p>${escapeHtml(error)}</p>`);
        reject(new Error(`OAuth error: ${error}`));
        cleanup();
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Authentication Failed</h1><p>Invalid state parameter</p>");
        reject(new Error("Invalid state — possible CSRF"));
        cleanup();
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Authentication Failed</h1><p>No authorization code</p>");
        reject(new Error("No authorization code received"));
        cleanup();
        return;
      }

      try {
        const tokens = await exchangeCode(code, clientId, redirectUri, verifier);
        const character = decodeCharacterFromJwt(tokens.accessToken);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<h1>Authentication Successful!</h1><p>Logged in as <strong>${escapeHtml(character.characterName)}</strong>. You can close this tab.</p>`
        );
        resolve({
          tokens,
          character: { ...character, scopes: selectedScopes.join(" ") },
        });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("<h1>Authentication Failed</h1><p>Token exchange error</p>");
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        cleanup();
      }
    });

    const timeout = setTimeout(() => {
      reject(new Error("Login timed out after 5 minutes. Start a new login with esi_login."));
      cleanup();
    }, LOGIN_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timeout);
      server.close();
      pendingFlow = null;
      pendingPromise = null;
    }

    server.listen(CALLBACK_PORT, () => {
      process.stderr.write(
        `OAuth callback server listening on http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}\n`
      );
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

    pendingFlow = { verifier, state, clientId, resolve, reject, server, timeout };
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
