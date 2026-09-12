import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { corporationEndpoints } from "../corporation-endpoints.js";
import { esiGet, esiGetAll, getActiveCharacter } from "../auth/esi-client.js";
import { jsonResult } from "../utils.js";
import { enrichDailyData } from "./daily.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function registerCorporationTools(server: McpServer): void {
  for (const endpoint of corporationEndpoints) {
    if (endpoint.existing) continue;
    const shape: Record<string, z.ZodType> = {
      character_id: id.optional(), corporation_id: id.optional(),
      limit: id.max(1000).default(100), offset: z.number().int().min(0).default(0),
    };
    for (const parameter of endpoint.parameters) {
      shape[parameter.name] = parameter.required ? id : id.optional();
    }
    server.tool(endpoint.name, `${endpoint.description} ${endpoint.scopes.length ? `Requires ${endpoint.scopes.join(", ")} and ESI-enforced corporation permissions; select an authorized CEO/director character.` : "Public when corporation_id is supplied."} Preserves ESI fields.`, shape, async (args) => {
      const privateRead = endpoint.scopes.length > 0;
      const char = privateRead || args.corporation_id === undefined ? await getActiveCharacter(args.character_id as number | undefined) : undefined;
      if (privateRead) {
        const granted = new Set(char!.scopes.split(/\s+/));
        const missing = endpoint.scopes.filter(scope => !granted.has(scope));
        if (missing.length) throw new Error(`Missing ${missing.join(", ")}. Run esi_login again for this character and approve the updated scopes.`);
      }
      const corp = args.corporation_id ?? (await esiGet<{ corporation_id: number }>(`/characters/${char!.characterId}/`, { public: true })).corporation_id;
      let path: string = endpoint.path.replace("{corporation_id}", String(corp));
      const query = new URLSearchParams();
      for (const parameter of endpoint.parameters) {
        const value = args[parameter.name];
        if (value === undefined) continue;
        if (parameter.location === "path") path = path.replace(`{${parameter.name}}`, String(value));
        else query.set(parameter.name, String(value));
      }
      path += "/" + (query.size ? `?${query}` : "");
      const options = privateRead ? { characterId: char!.characterId } : { public: true };
      const data = endpoint.paginated ? await esiGetAll<unknown>(path, options) : await esiGet<unknown>(path, options);
      if (!Array.isArray(data)) return jsonResult(data);
      const limit = args.limit as number, offset = args.offset as number;
      return jsonResult({ count: data.length, offset, nextOffset: offset + limit < data.length ? offset + limit : null,
        data: enrichDailyData(data.slice(offset, offset + limit)) });
    });
  }
}
