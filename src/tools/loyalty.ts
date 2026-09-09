import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { esiGet, esiPost, getActiveCharacter } from "../auth/esi-client.js";
import {
  listLoyaltyPointActivity,
  recordLoyaltyPointSnapshot,
  type LoyaltyPointBalance,
} from "../auth/tokens.js";
import { jsonResult } from "../utils.js";

interface EsiLoyaltyPoint {
  corporation_id: number;
  loyalty_points: number;
}

interface EsiName {
  id: number;
  name: string;
  category: string;
}

async function fetchBalances(characterId: number): Promise<LoyaltyPointBalance[]> {
  const rows = await esiGet<EsiLoyaltyPoint[]>(
    `/characters/${characterId}/loyalty/points/`,
    { characterId }
  );
  return rows.map((row) => ({
    corporationId: row.corporation_id,
    loyaltyPoints: row.loyalty_points,
  }));
}

async function resolveCorporationNames(
  characterId: number,
  corporationIds: number[]
): Promise<Map<number, string>> {
  if (corporationIds.length === 0) return new Map();
  const rows = await esiPost<EsiName[]>("/universe/names/", corporationIds, { characterId });
  return new Map(rows.map((row) => [row.id, row.name]));
}

export function registerLoyaltyTools(server: McpServer): void {
  server.tool(
    "get_loyalty_points",
    "Use this to get the authenticated character's current loyalty point (LP) wallet balances by NPC corporation. Records a local snapshot for later LP activity comparisons.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const balances = await fetchBalances(char.characterId);
      const changes = recordLoyaltyPointSnapshot(char.characterId, balances);
      const names = await resolveCorporationNames(
        char.characterId,
        balances.map((row) => row.corporationId)
      );
      const enriched = balances
        .map((row) => ({
          corporationId: row.corporationId,
          corporationName: names.get(row.corporationId) ?? `Unknown (${row.corporationId})`,
          loyaltyPoints: row.loyaltyPoints,
        }))
        .sort((a, b) => b.loyaltyPoints - a.loyaltyPoints);

      return jsonResult({
        characterName: char.characterName,
        totalLoyaltyPoints: enriched.reduce((sum, row) => sum + row.loyaltyPoints, 0),
        corporationCount: enriched.length,
        balances: enriched,
        changesObservedThisPoll: changes.length,
      });
    }
  );

  server.tool(
    "get_loyalty_point_activity",
    "Use this to inspect LP wallet gains and spending observed by this MCP over time. ESI has no historical LP journal, so the first call establishes a baseline and later calls record balance changes.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      corporation_id: z.number().optional().describe("Filter to one NPC corporation ID"),
      since: z.string().optional().describe("Only include observations at or after this ISO timestamp"),
      limit: z.number().int().min(1).max(500).default(100).describe("Maximum activity records"),
      refresh: z.boolean().default(true).describe("Poll current ESI balances before returning activity"),
    },
    async ({ character_id, corporation_id, since, limit, refresh }) => {
      const char = await getActiveCharacter(character_id);
      let changesObservedThisPoll = 0;
      if (refresh) {
        const balances = await fetchBalances(char.characterId);
        changesObservedThisPoll = recordLoyaltyPointSnapshot(char.characterId, balances).length;
      }
      const activity = listLoyaltyPointActivity(char.characterId, {
        corporationId: corporation_id,
        since,
        limit,
      });
      const names = await resolveCorporationNames(
        char.characterId,
        [...new Set(activity.map((row) => row.corporationId))]
      );

      return jsonResult({
        characterName: char.characterName,
        trackingNote:
          "ESI exposes current LP balances only. These entries are changes observed between MCP polls, not Fenris Creations transaction records. The MCP respects ESI freshness headers; upstream caching can delay visible changes.",
        changesObservedThisPoll,
        count: activity.length,
        activity: activity.map((row) => ({
          ...row,
          corporationName: names.get(row.corporationId) ?? `Unknown (${row.corporationId})`,
          direction: row.delta > 0 ? "earned" : "spent",
        })),
      });
    }
  );
}
