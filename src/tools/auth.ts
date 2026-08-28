import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startLoginFlow, waitForLogin } from "../auth/oauth.js";
import {
  storeTokens,
  listCharacters,
  removeTokens,
  getCurrentCharacter,
  setCurrentCharacterId,
} from "../auth/tokens.js";
import { readClientId } from "../auth/esi-client.js";
import { getSdeDir } from "../database.js";

type LoginState =
  | { status: "idle" }
  | { status: "pending"; startedAt: string }
  | { status: "succeeded"; characterName: string; characterId: number; completedAt: string }
  | { status: "failed"; error: string; completedAt: string };

let loginState: LoginState = { status: "idle" };
let loginAttemptId = 0;

export function registerAuthTools(server: McpServer): void {
  server.tool(
    "esi_login",
    "Start EVE SSO login. Returns an authorization URL immediately. Open it on the MCP host within 5 minutes, then use esi_status to confirm completion.",
    {
      client_id: z
        .string()
        .optional()
        .describe("EVE SSO Client ID. Falls back to ~/.eve-sde/config.json if not provided."),
    },
    async ({ client_id }) => {
      let clientId = client_id;
      if (!clientId) {
        try {
          clientId = readClientId();
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "No client_id provided and no config.json found at ~/.eve-sde/config.json. Please provide a client_id parameter or create the config file with: { \"clientId\": \"your_id\" }",
              },
            ],
          };
        }
      }

      // Save client ID to config if not already there
      const configPath = path.join(getSdeDir(), "config.json");
      if (!fs.existsSync(configPath)) {
        fs.mkdirSync(getSdeDir(), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ clientId }, null, 2));
      }

      const { authUrl } = startLoginFlow(clientId);
      const attemptId = ++loginAttemptId;
      loginState = { status: "pending", startedAt: new Date().toISOString() };

      // Complete the callback and token storage independently of this MCP request.
      // This keeps remote clients from timing out while the user signs in.
      void waitForLogin()
        .then((result) => {
          if (attemptId !== loginAttemptId) return;
          storeTokens(result.tokens, result.character);
          setCurrentCharacterId(result.character.characterId);
          loginState = {
            status: "succeeded",
            characterName: result.character.characterName,
            characterId: result.character.characterId,
            completedAt: new Date().toISOString(),
          };
          process.stderr.write(
            `EVE SSO authenticated as ${result.character.characterName} (${result.character.characterId}).\n`
          );
        })
        .catch((err) => {
          if (attemptId !== loginAttemptId) return;
          const message = err instanceof Error ? err.message : String(err);
          loginState = { status: "failed", error: message, completedAt: new Date().toISOString() };
          process.stderr.write(`EVE SSO login failed: ${message}\n`);
        });

      return {
        content: [
          {
            type: "text",
            text:
              `Open this EVE SSO authorization URL on the Windows machine running the MCP within 5 minutes:\n\n${authUrl}\n\n` +
              "After approving the requested scopes and selecting a character, use esi_status to confirm the connection.",
          },
        ],
      };
    }
  );

  server.tool(
    "esi_status",
    "Show ESI authentication status — authenticated characters, token expiry, and scopes.",
    {},
    async () => {
      const characters = listCharacters();
      if (characters.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  login: loginState,
                  currentCharacter: null,
                  characters: [],
                  message: "No authenticated characters. Use esi_login to authenticate.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const current = getCurrentCharacter();
      const result = {
        login: loginState,
        currentCharacter: current
          ? { name: current.characterName, id: current.characterId }
          : null,
        characters: characters.map((c) => ({
          characterId: c.characterId,
          characterName: c.characterName,
          tokenExpiry: c.expiresAt.toISOString(),
          tokenExpired: c.expiresAt < new Date(),
          scopes: c.scopes,
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "esi_logout",
    "Remove stored tokens for a character.",
    {
      character_id: z.number().describe("Character ID to log out"),
    },
    async ({ character_id }) => {
      removeTokens(character_id);
      return {
        content: [{ type: "text", text: `Logged out character ${character_id}.` }],
      };
    }
  );

  server.tool(
    "esi_switch_character",
    "Switch the active character for ESI queries.",
    {
      character_id: z.number().describe("Character ID to switch to"),
    },
    async ({ character_id }) => {
      const characters = listCharacters();
      const match = characters.find((c) => c.characterId === character_id);
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `Character ${character_id} not found. Authenticated characters: ${characters.map((c) => `${c.characterName} (${c.characterId})`).join(", ") || "none"}`,
            },
          ],
        };
      }
      setCurrentCharacterId(character_id);
      return {
        content: [
          { type: "text", text: `Switched to ${match.characterName} (${match.characterId}).` },
        ],
      };
    }
  );
}
