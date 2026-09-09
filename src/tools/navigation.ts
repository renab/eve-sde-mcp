import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiPost, getActiveCharacter } from "../auth/esi-client.js";
import { jsonResult } from "../utils.js";

export function registerNavigationTools(server: McpServer): void {
  server.tool(
    "set_autopilot_destination",
    "Set an in-game autopilot destination or waypoint for the authenticated character. This changes the route shown in the EVE client and requires esi-ui.write_waypoint.v1. Provide a solar-system name or a solar-system, station, or structure ID.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      destination_id: z
        .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
        .optional()
        .describe("Solar system, station, or structure ID; pass large structure IDs as a numeric string"),
      system_name: z.string().optional().describe("Exact solar-system name; used when destination_id is omitted"),
      clear_other_waypoints: z.boolean().default(true).describe("Clear the existing route before setting this destination"),
      add_to_beginning: z.boolean().default(false).describe("Add this waypoint to the beginning rather than the end"),
    },
    async ({ character_id, destination_id, system_name, clear_other_waypoints, add_to_beginning }) => {
      const char = await getActiveCharacter(character_id);
      if (!char.scopes.split(" ").includes("esi-ui.write_waypoint.v1")) {
        throw new Error(
          "The selected character token does not include esi-ui.write_waypoint.v1. Run esi_login again and approve the updated scopes."
        );
      }
      let destinationId = destination_id;
      let destinationName: string | null = null;

      if (destinationId === undefined && system_name) {
        const row = getDatabase()
          .prepare(
            "SELECT solarSystemID, solarSystemName FROM mapSolarSystems WHERE solarSystemName = ? COLLATE NOCASE"
          )
          .get(system_name) as { solarSystemID: number; solarSystemName: string } | undefined;
        if (!row) {
          throw new Error(`Solar system \"${system_name}\" was not found. Use search_systems to find its exact name or provide destination_id.`);
        }
        destinationId = row.solarSystemID;
        destinationName = row.solarSystemName;
      }

      if (destinationId === undefined) {
        throw new Error("Provide either destination_id or system_name.");
      }

      const query = new URLSearchParams({
        add_to_beginning: String(add_to_beginning),
        clear_other_waypoints: String(clear_other_waypoints),
        destination_id: String(destinationId),
      });
      await esiPost<void>(`/ui/autopilot/waypoint/?${query.toString()}`, undefined, {
        characterId: char.characterId,
      });

      return jsonResult({
        success: true,
        characterName: char.characterName,
        destinationId,
        destinationName,
        clearOtherWaypoints: clear_other_waypoints,
        addToBeginning: add_to_beginning,
      });
    }
  );
}
