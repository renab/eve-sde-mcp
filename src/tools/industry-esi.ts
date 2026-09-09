import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, esiGetAll, getActiveCharacter, ESI_CACHE_TTL } from "../auth/esi-client.js";
import { enrichTypeName, likeContains, jsonResult } from "../utils.js";

interface EsiIndustryJob {
  job_id: number;
  installer_id: number;
  facility_id: number;
  station_id: number;
  activity_id: number;
  blueprint_id: number;
  blueprint_type_id: number;
  blueprint_location_id: number;
  output_location_id: number;
  runs: number;
  cost?: number;
  licensed_runs?: number;
  probability?: number;
  product_type_id?: number;
  status: string;
  duration: number;
  start_date: string;
  end_date: string;
  pause_date?: string;
  completed_date?: string;
  completed_character_id?: number;
  successful_runs?: number;
}

interface EsiCostIndex {
  solar_system_id: number;
  cost_indices: Array<{
    activity: string;
    cost_index: number;
  }>;
}

const ACTIVITY_NAMES: Record<number, string> = {
  1: "Manufacturing",
  3: "TE Research",
  4: "ME Research",
  5: "Copying",
  7: "Reverse Engineering",
  8: "Invention",
  9: "Reaction",
  11: "Reaction",
};

const COST_INDEX_CACHE_TTL = 10 * 60 * 1000;

export function registerIndustryEsiTools(server: McpServer): void {
  server.tool(
    "get_industry_jobs",
    "Get active and recent industry jobs for the authenticated character — manufacturing, research, invention, reactions. Supports filtering by activity and status.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      include_completed: z.boolean().default(false).describe("Include completed jobs"),
      activity: z.string().optional().describe("Filter by activity name (e.g. 'Manufacturing', 'Invention', 'Reaction')"),
      status: z.enum(["active", "cancelled", "delivered", "paused", "ready"]).optional().describe("Filter by job status"),
    },
    async ({ character_id, include_completed, activity, status }) => {
      const char = await getActiveCharacter(character_id);
      let url = `/characters/${char.characterId}/industry/jobs/`;
      if (include_completed) url += "?include_completed=true";

      const jobs = await esiGet<EsiIndustryJob[]>(url, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

      const db = getDatabase();
      let enriched = jobs.map((j) => ({
        jobId: j.job_id,
        activity: ACTIVITY_NAMES[j.activity_id] ?? `Activity ${j.activity_id}`,
        blueprintName: enrichTypeName(db, j.blueprint_type_id),
        blueprintTypeId: j.blueprint_type_id,
        productName: j.product_type_id ? enrichTypeName(db, j.product_type_id) : null,
        productTypeId: j.product_type_id ?? null,
        runs: j.runs,
        status: j.status,
        cost: j.cost,
        startDate: j.start_date,
        endDate: j.end_date,
        completedDate: j.completed_date ?? null,
        successfulRuns: j.successful_runs ?? null,
        facilityId: j.facility_id,
      }));

      if (activity) enriched = enriched.filter((j) => j.activity.toLowerCase() === activity.toLowerCase());
      if (status) enriched = enriched.filter((j) => j.status === status);

      return jsonResult({
        characterName: char.characterName,
        activeJobs: enriched.filter((j) => j.status === "active").length,
        totalJobs: enriched.length,
        jobs: enriched,
      });
    }
  );

  server.tool(
    "get_industry_cost_indices",
    "Get system cost indices for industry activities (public, no auth). Shows manufacturing/research/invention costs per solar system.",
    {
      system_name: z.string().optional().describe("Filter by solar system name"),
      system_id: z.number().optional().describe("Filter by solar system ID"),
    },
    async ({ system_name, system_id }) => {
      const indices = await esiGet<EsiCostIndex[]>("/industry/systems/", {
        public: true,
        cacheTtlMs: COST_INDEX_CACHE_TTL,
      });

      let systemId = system_id;
      if (system_name && !systemId) {
        const db = getDatabase();
        const row = db
          .prepare("SELECT solarSystemID FROM mapSolarSystems WHERE solarSystemName LIKE ? ESCAPE '\\'")
          .get(likeContains(system_name)) as { solarSystemID: number } | undefined;
        if (!row) {
          return { content: [{ type: "text", text: `System "${system_name}" not found in SDE.` }] };
        }
        systemId = row.solarSystemID;
      }

      if (systemId) {
        const match = indices.find((i) => i.solar_system_id === systemId);
        if (!match) {
          return { content: [{ type: "text", text: `No cost index data for system ${systemId}.` }] };
        }

        const db = getDatabase();
        const sysInfo = db
          .prepare("SELECT solarSystemName FROM mapSolarSystems WHERE solarSystemID = ?")
          .get(systemId) as { solarSystemName: string } | undefined;

        return jsonResult({
          systemName: sysInfo?.solarSystemName ?? systemId,
          systemId,
          costIndices: match.cost_indices,
        });
      }

      return jsonResult({ count: indices.length, note: "Use system_name or system_id to filter. Returns all ~5k systems otherwise." });
    }
  );

  server.tool(
    "get_character_assets",
    "Get assets (items in hangars/containers) for the authenticated character, enriched with item names.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type_name: z.string().optional().describe("Filter assets by item name"),
      location_id: z.number().optional().describe("Filter by location ID"),
    },
    async ({ character_id, type_name, location_id }) => {
      const char = await getActiveCharacter(character_id);
      const assets = await esiGetAll<{
        item_id: number;
        type_id: number;
        location_id: number;
        location_type: string;
        quantity: number;
        location_flag: string;
        is_singleton: boolean;
      }>(`/characters/${char.characterId}/assets/`, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

      const db = getDatabase();
      let enriched = assets.map((a) => ({
        itemId: a.item_id,
        typeName: enrichTypeName(db, a.type_id),
        typeId: a.type_id,
        quantity: a.quantity,
        locationId: a.location_id,
        locationType: a.location_type,
        locationFlag: a.location_flag,
        isSingleton: a.is_singleton,
      }));

      if (type_name) {
        enriched = enriched.filter((a) =>
          a.typeName.toLowerCase().includes(type_name.toLowerCase())
        );
      }
      if (location_id) {
        enriched = enriched.filter((a) => a.locationId === location_id);
      }

      return jsonResult({ characterName: char.characterName, assetCount: enriched.length, assets: enriched });
    }
  );

  server.tool(
    "get_corporation_assets",
    "Get corporation assets visible to the authenticated character, enriched with SDE type names. Requires the esi-assets.read_corporation_assets.v1 scope and the Director corporation role.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      corporation_id: z.number().optional().describe("Corporation ID (defaults to the authenticated character's current corporation)"),
      type_name: z.string().optional().describe("Filter assets by item type name"),
      location_id: z.number().optional().describe("Filter by location ID"),
      location_flag: z.string().optional().describe("Filter by location flag, such as CorpSAG1 or Deliveries"),
      limit: z.number().int().min(1).max(5000).default(500).describe("Maximum assets to return after filtering"),
      offset: z.number().int().min(0).default(0).describe("Number of filtered assets to skip"),
    },
    async ({ character_id, corporation_id, type_name, location_id, location_flag, limit, offset }) => {
      const char = await getActiveCharacter(character_id);
      if (!char.scopes.split(" ").includes("esi-assets.read_corporation_assets.v1")) {
        throw new Error(
          "The selected character token does not include esi-assets.read_corporation_assets.v1. Run esi_login again and approve the updated scopes."
        );
      }
      let corporationId = corporation_id;
      if (!corporationId) {
        const publicCharacter = await esiGet<{ corporation_id: number }>(
          `/characters/${char.characterId}/`,
          { public: true, cacheTtlMs: ESI_CACHE_TTL }
        );
        corporationId = publicCharacter.corporation_id;
      }

      const assets = await esiGetAll<{
        item_id: number;
        type_id: number;
        location_id: number;
        location_type: string;
        quantity: number;
        location_flag: string;
        is_singleton: boolean;
        is_blueprint_copy?: boolean;
      }>(`/corporations/${corporationId}/assets/`, {
        characterId: char.characterId,
        cacheTtlMs: ESI_CACHE_TTL,
      });

      const db = getDatabase();
      let enriched = assets.map((asset) => ({
        itemId: asset.item_id,
        typeName: enrichTypeName(db, asset.type_id),
        typeId: asset.type_id,
        quantity: asset.quantity,
        locationId: asset.location_id,
        locationType: asset.location_type,
        locationFlag: asset.location_flag,
        isSingleton: asset.is_singleton,
        isBlueprintCopy: asset.is_blueprint_copy ?? false,
      }));

      if (type_name) {
        const query = type_name.toLowerCase();
        enriched = enriched.filter((asset) => asset.typeName.toLowerCase().includes(query));
      }
      if (location_id !== undefined) {
        enriched = enriched.filter((asset) => asset.locationId === location_id);
      }
      if (location_flag) {
        const query = location_flag.toLowerCase();
        enriched = enriched.filter((asset) => asset.locationFlag.toLowerCase() === query);
      }

      const filteredAssetCount = enriched.length;
      const page = enriched.slice(offset, offset + limit);
      return jsonResult({
        characterName: char.characterName,
        corporationId,
        totalCorporationAssets: assets.length,
        filteredAssetCount,
        returnedAssetCount: page.length,
        offset,
        limit,
        assets: page,
      });
    }
  );

  server.tool(
    "get_character_contracts",
    "Get contracts for the authenticated character — courier, item exchange, and auction contracts. Supports filtering by type and status.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type: z.enum(["unknown", "item_exchange", "auction", "courier"]).optional().describe("Filter by contract type"),
      status: z.enum(["outstanding", "in_progress", "finished_issuer", "finished_contractor", "finished", "cancelled", "rejected", "failed", "deleted", "reversed"]).optional().describe("Filter by contract status"),
    },
    async ({ character_id, type, status }) => {
      const char = await getActiveCharacter(character_id);
      let contracts = await esiGetAll<{
        contract_id: number;
        issuer_id: number;
        assignee_id: number;
        type: string;
        status: string;
        title: string;
        price: number;
        reward: number;
        collateral: number;
        volume: number;
        date_issued: string;
        date_expired: string;
        date_completed?: string;
        start_location_id?: number;
        end_location_id?: number;
      }>(`/characters/${char.characterId}/contracts/`, { characterId: char.characterId, cacheTtlMs: ESI_CACHE_TTL });

      if (type) contracts = contracts.filter((c) => c.type === type);
      if (status) contracts = contracts.filter((c) => c.status === status);

      return jsonResult({ characterName: char.characterName, contractCount: contracts.length, contracts });
    }
  );
}
