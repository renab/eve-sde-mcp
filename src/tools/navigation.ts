import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiCalculateRoute, esiPost, getActiveCharacter } from "../auth/esi-client.js";
import { jsonResult } from "../utils.js";
import { securityInfo, shortestHighsecRoute } from "../route-security.js";

export function registerNavigationTools(server: McpServer): void {
  server.tool(
    "get_route",
    "Calculate a route between solar-system IDs or exact names. Existing preferences use ESI; highsec_only finds the shortest stargate path in the installed SDE restricted to raw security >= 0.45, failing if none exists. Returns ordered systems and security summaries including both endpoints. Public: no login required; does not read or change autopilot. Safer/highsec are not safety guarantees. For stations/structures, supply their solar system.",
    {
      origin: z.union([z.number().int().positive(), z.string().trim().min(1)]),
      destination: z.union([z.number().int().positive(), z.string().trim().min(1)]),
      preference: z.enum(["shorter", "safer", "less_secure", "highsec_only"]).default("shorter"),
      security_penalty: z.number().int().min(0).max(100).default(50).describe("Strictness of ESI route preference; ignored for highsec_only"),
      avoid_systems: z.array(z.union([z.number().int().positive(), z.string().trim().min(1)])).max(1000).default([]).describe("Solar-system IDs or exact names"),
    },
    async ({ origin, destination, preference, security_penalty, avoid_systems }) => {
      const db = getDatabase();
      type System = { solarSystemID: number; solarSystemName: string; security: number };
      const resolve = (value: string | number): System => {
        const byId = typeof value === "number" || /^\d+$/.test(value);
        const row = db.prepare(`SELECT solarSystemID, solarSystemName, security FROM mapSolarSystems WHERE ${byId ? "solarSystemID = ?" : "solarSystemName = ? COLLATE NOCASE"}`)
          .get(byId ? Number(value) : value) as System | undefined;
        if (!row) throw new Error(`Solar system "${value}" was not found. Use search_systems to find its exact name or ID.`);
        return row;
      };
      const from = resolve(origin);
      const to = resolve(destination);
      // Preserve numeric-ID forwarding for existing callers; resolve names just like endpoints.
      const avoided = [...new Set(avoid_systems.map(value => typeof value === "number" ? value : resolve(value).solarSystemID))];
      const preferences = { shorter: "Shorter", safer: "Safer", less_secure: "LessSecure" } as const;
      let route: number[];
      if (preference === "highsec_only") {
        if (securityInfo(from.security).securityClass !== "highsec" || securityInfo(to.security).securityClass !== "highsec") {
          throw new Error("highsec_only requires both origin and destination to be highsec (raw security >= 0.45).");
        }
        const edges = db.prepare(`SELECT j.fromSolarSystemID, j.toSolarSystemID FROM mapSolarSystemJumps j
          JOIN mapSolarSystems f ON f.solarSystemID = j.fromSolarSystemID
          JOIN mapSolarSystems t ON t.solarSystemID = j.toSolarSystemID
          WHERE f.security >= 0.45 AND t.security >= 0.45
          ORDER BY j.fromSolarSystemID, j.toSolarSystemID`).all() as { fromSolarSystemID: number; toSolarSystemID: number }[];
        route = shortestHighsecRoute(from.solarSystemID, to.solarSystemID, edges, avoided);
      } else {
        ({ route } = await esiCalculateRoute(from.solarSystemID, to.solarSystemID, {
          preference: preferences[preference], security_penalty, avoid_systems: avoided,
        }));
      }
      const lookup = db.prepare("SELECT solarSystemID, solarSystemName, security FROM mapSolarSystems WHERE solarSystemID = ?");
      const systems = route.map(id => {
        const system = lookup.get(id) as System | undefined;
        const securityStatus = system?.security ?? null;
        return { systemId: id, systemName: system?.solarSystemName ?? null, securityStatus, ...securityInfo(securityStatus) };
      });
      const highsecSystemCount = systems.filter(s => s.securityClass === "highsec").length;
      const lowsecSystemCount = systems.filter(s => s.securityClass === "lowsec").length;
      const nullsecSystemCount = systems.filter(s => s.securityClass === "nullsec").length;
      const unknownSecuritySystemCount = systems.filter(s => s.securityClass === null).length;
      return jsonResult({
        source: preference === "highsec_only" ? "Installed SDE highsec-only stargate calculation" : "ESI route calculation", origin: from, destination: to, preference,
        securityPenalty: security_penalty, avoidSystems: avoided,
        jumpCount: Math.max(0, route.length - 1), systemIds: route,
        systems,
        minimumSecurity: unknownSecuritySystemCount || !systems.length ? null : Math.min(...systems.map(s => s.securityStatus!)),
        highsecSystemCount, lowsecSystemCount, nullsecSystemCount, unknownSecuritySystemCount,
        containsLowsec: lowsecSystemCount > 0 ? true : unknownSecuritySystemCount > 0 ? null : false,
        containsNullsec: nullsecSystemCount > 0 ? true : unknownSecuritySystemCount > 0 ? null : false,
      });
    }
  );

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
