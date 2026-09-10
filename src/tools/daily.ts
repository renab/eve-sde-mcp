import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { esiGet, esiGetAll, getActiveCharacter } from "../auth/esi-client.js";
import { getDatabase } from "../database.js";
import { enrichTypeName, enrichSystemName, jsonResult } from "../utils.js";

// Keep ESI fields intact while adding human-readable names alongside IDs.
export function enrichDailyData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(enrichDailyData);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(row)) {
    result[key] = enrichDailyData(item);
    if ((key === "type_id" || key === "ship_type_id") && typeof item === "number") {
      result[key.replace("_id", "_name")] = enrichTypeName(getDatabase(), item);
    }
    if (key === "solar_system_id" && typeof item === "number") {
      result.solar_system_name = enrichSystemName(getDatabase(), item);
    }
    if (key === "implants" && Array.isArray(item)) {
      result.implant_names = item.map((id: number) => enrichTypeName(getDatabase(), id));
    }
  }
  return result;
}

export function registerDailyTools(server: McpServer): void {
  const singles = [
    ["get_character_location", "location", "esi-location.read_location.v1", "Read current system and docked station/structure IDs. Player structures are automatically enriched with cached names/type/owner and freshness when accessible; raw IDs always remain available."],
    ["get_character_ship", "ship", "esi-location.read_ship_type.v1", "Read the character's current ship, its item ID, type and custom name."],
    ["get_character_clones", "clones", "esi-clones.read_clones.v1", "Read home station, jump clones, installed clone implants and jump timestamps."],
    ["get_character_implants", "implants", "esi-clones.read_implants.v1", "Read active-clone implant IDs and names for training and fitting decisions."],
  ] as const;
  for (const [name, route, scope, description] of singles) {
    server.tool(name, `${description} Requires ${scope}.`, {
      character_id: z.number().int().positive().optional(),
    }, async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      requireScope(char.scopes, scope);
      const data = await esiGet<unknown>(`/characters/${char.characterId}/${route}/`, { characterId: char.characterId });
      return jsonResult({ characterId: char.characterId, characterName: char.characterName,
        data: route === "implants" ? (data as number[]).map(type_id => ({ type_id, type_name: enrichTypeName(getDatabase(), type_id) })) : enrichDailyData(data) });
    });
  }

  for (const [name, route, scope, description] of [
    ["get_character_mining", "mining", "esi-industry.read_character_mining.v1", "Read the available 30-day mining ledger, with ore and system names."],
    ["get_character_blueprints", "blueprints", "esi-characters.read_blueprints.v1", "Read owned blueprints, material/time efficiency, remaining runs and location. ESI quantity -1 denotes an original, -2 a copy."],
    ["get_contract_items", "contracts", "esi-contracts.read_character_contracts.v1", "Read contract contents, quantities and included/requested flags. Provide contract_id from get_character_contracts."],
  ] as const) {
    server.tool(name, `${description} Requires ${scope}.`, {
      character_id: z.number().int().positive().optional(),
      contract_id: z.number().int().positive().optional().describe("Required for get_contract_items"),
      type_id: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).default(0),
    }, async ({ character_id, contract_id, type_id, limit, offset }) => {
      if (route === "contracts" && !contract_id) throw new Error("Provide contract_id from get_character_contracts.");
      const char = await getActiveCharacter(character_id);
      requireScope(char.scopes, scope);
      const suffix = route === "contracts" ? `contracts/${contract_id}/items` : route;
      const rows = await esiGetAll<Record<string, unknown>>(`/characters/${char.characterId}/${suffix}/`, { characterId: char.characterId });
      const filtered = type_id === undefined ? rows : rows.filter(row => row.type_id === type_id);
      return jsonResult({ characterId: char.characterId, characterName: char.characterName,
        totalCount: rows.length, filteredCount: filtered.length, offset,
        nextOffset: offset + limit < filtered.length ? offset + limit : null,
        data: enrichDailyData(filtered.slice(offset, offset + limit)) });
    });
  }
}

function requireScope(scopes: string, required: string): void {
  if (!scopes.split(/\s+/).includes(required)) {
    throw new Error(`Missing ${required}. Run esi_login for this character and approve the updated scopes.`);
  }
}
