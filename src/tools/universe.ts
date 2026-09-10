import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { likeContains, jsonResult } from "../utils.js";
import { EntityIndex, endpointDiscoveryShape } from "../entities.js";
import { getStateDatabase } from "../persistence.js";

export function registerUniverseTools(server: McpServer): void {
  server.tool(
    "search_systems",
    "Search Eve Online solar systems by name.",
    {
      query: z.string().describe("System name or partial name"),
      limit: z.number().default(25).describe("Max results"),
    },
    async ({ query, limit }) => {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT s.solarSystemID, s.solarSystemName, s.security,
                  c.constellationName, r.regionName
           FROM mapSolarSystems s
           JOIN mapConstellations c ON s.constellationID = c.constellationID
           JOIN mapRegions r ON s.regionID = r.regionID
           WHERE s.solarSystemName LIKE ? ESCAPE '\\'
           ORDER BY s.solarSystemName
           LIMIT ?`
        )
        .all(likeContains(query), limit);
      return jsonResult(rows);
    }
  );

  server.tool(
    "get_system",
    "Get details for an Eve Online solar system — security status, constellation, region, and connected stargates.",
    {
      ...endpointDiscoveryShape,
      system_id: z.number().optional().describe("solarSystemID"),
      name: z.string().optional().describe("System name (if system_id not provided)"),
    },
    async ({ system_id, name, include_related, record_namespace, related_limit }) => {
      const db = getDatabase();

      let system: unknown;
      if (system_id) {
        system = db
          .prepare(
            `SELECT s.*, c.constellationName, r.regionName
             FROM mapSolarSystems s
             JOIN mapConstellations c ON s.constellationID = c.constellationID
             JOIN mapRegions r ON s.regionID = r.regionID
             WHERE s.solarSystemID = ?`
          )
          .get(system_id);
      } else if (name) {
        system = db
          .prepare(
            `SELECT s.*, c.constellationName, r.regionName
             FROM mapSolarSystems s
             JOIN mapConstellations c ON s.constellationID = c.constellationID
             JOIN mapRegions r ON s.regionID = r.regionID
             WHERE s.solarSystemName LIKE ? ESCAPE '\\'`
          )
          .get(likeContains(name));
      } else {
        return { content: [{ type: "text", text: "Provide either system_id or name." }] };
      }

      if (!system) {
        return { content: [{ type: "text", text: "System not found." }] };
      }

      const jumps = db
        .prepare(
          `SELECT j.toSolarSystemID, s.solarSystemName, s.security
           FROM mapSolarSystemJumps j
           JOIN mapSolarSystems s ON j.toSolarSystemID = s.solarSystemID
           WHERE j.fromSolarSystemID = ?
           ORDER BY s.solarSystemName`
        )
        .all((system as any).solarSystemID);

      const stations = db
        .prepare(
          `SELECT stationID, stationName
           FROM staStations
           WHERE solarSystemID = ?
           ORDER BY stationName`
        )
        .all((system as any).solarSystemID);

      return jsonResult({ system, connectedSystems: jumps, stations,
        ...(include_related ? new EntityIndex(getStateDatabase()).related({ namespace: record_namespace,
          entity_refs: [{ type: "solar_system", id: String((system as any).solarSystemID) }], limit: related_limit }) : {}) });
    }
  );

  server.tool(
    "get_region",
    "Get an Eve Online region with its constellations and system count.",
    {
      region_id: z.number().optional().describe("regionID"),
      name: z.string().optional().describe("Region name (if region_id not provided)"),
    },
    async ({ region_id, name }) => {
      const db = getDatabase();

      let region: unknown;
      if (region_id) {
        region = db.prepare("SELECT * FROM mapRegions WHERE regionID = ?").get(region_id);
      } else if (name) {
        region = db
          .prepare("SELECT * FROM mapRegions WHERE regionName LIKE ? ESCAPE '\\'")
          .get(likeContains(name));
      } else {
        return { content: [{ type: "text", text: "Provide either region_id or name." }] };
      }

      if (!region) {
        return { content: [{ type: "text", text: "Region not found." }] };
      }

      const constellations = db
        .prepare(
          `SELECT c.constellationID, c.constellationName,
                  COUNT(s.solarSystemID) as systemCount
           FROM mapConstellations c
           LEFT JOIN mapSolarSystems s ON c.constellationID = s.constellationID
           WHERE c.regionID = ?
           GROUP BY c.constellationID
           ORDER BY c.constellationName`
        )
        .all((region as any).regionID);

      return jsonResult({ region, constellations });
    }
  );

  server.tool(
    "get_station",
    "Get Eve Online station details.",
    {
      station_id: z.number().optional().describe("stationID"),
      name: z.string().optional().describe("Station name (if station_id not provided)"),
    },
    async ({ station_id, name }) => {
      const db = getDatabase();

      let station: unknown;
      if (station_id) {
        station = db
          .prepare(
            `SELECT st.*, s.solarSystemName, s.security, r.regionName
             FROM staStations st
             JOIN mapSolarSystems s ON st.solarSystemID = s.solarSystemID
             JOIN mapRegions r ON st.regionID = r.regionID
             WHERE st.stationID = ?`
          )
          .get(station_id);
      } else if (name) {
        station = db
          .prepare(
            `SELECT st.*, s.solarSystemName, s.security, r.regionName
             FROM staStations st
             JOIN mapSolarSystems s ON st.solarSystemID = s.solarSystemID
             JOIN mapRegions r ON st.regionID = r.regionID
             WHERE st.stationName LIKE ? ESCAPE '\\'
             LIMIT 1`
          )
          .get(likeContains(name));
      } else {
        return { content: [{ type: "text", text: "Provide either station_id or name." }] };
      }

      if (!station) {
        return { content: [{ type: "text", text: "Station not found." }] };
      }

      return jsonResult(station);
    }
  );
}
