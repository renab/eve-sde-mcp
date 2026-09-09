import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, esiGetWithMetadata, getActiveCharacter } from "../auth/esi-client.js";
import { enrichSystemName, enrichTypeName, jsonResult, likeContains } from "../utils.js";

const PLANETARY_SCOPE = "esi-planets.manage_planets.v1";

interface EsiColony {
  last_update: string;
  num_pins: number;
  owner_id: number;
  planet_id: number;
  planet_type: string;
  solar_system_id: number;
  upgrade_level: number;
}

interface EsiPlanetInfo {
  name: string;
  planet_id: number;
  system_id: number;
  type_id: number;
}

interface EsiColonyLayout {
  links: Array<{
    source_pin_id: number;
    destination_pin_id: number;
    link_level: number;
  }>;
  pins: Array<{
    pin_id: number;
    type_id: number;
    latitude: number;
    longitude: number;
    contents?: Array<{ type_id: number; amount: number }>;
    expiry_time?: string;
    install_time?: string;
    last_cycle_start?: string;
    schematic_id?: number;
    factory_details?: { schematic_id: number };
    extractor_details?: {
      cycle_time?: number;
      head_radius?: number;
      product_type_id?: number;
      qty_per_cycle?: number;
      heads: Array<{ head_id: number; latitude: number; longitude: number }>;
    };
  }>;
  routes: Array<{
    route_id: number;
    source_pin_id: number;
    destination_pin_id: number;
    content_type_id: number;
    quantity: number;
    waypoints?: number[];
  }>;
}

function requirePlanetaryScope(scopes: string): void {
  if (!scopes.split(" ").includes(PLANETARY_SCOPE)) {
    throw new Error(
      `The selected character token does not include ${PLANETARY_SCOPE}. Run esi_login again and approve the updated scopes.`
    );
  }
}

function getSchematic(schematicId: number) {
  const db = getDatabase();
  const schematic = db
    .prepare("SELECT schematicID, schematicName, cycleTime FROM planetSchematics WHERE schematicID = ?")
    .get(schematicId) as
    | { schematicID: number; schematicName: string; cycleTime: number }
    | undefined;
  if (!schematic) return null;

  const materials = db
    .prepare(
      `SELECT m.typeID, t.typeName, m.quantity, m.isInput
       FROM planetSchematicsTypeMap m
       LEFT JOIN invTypes t ON t.typeID = m.typeID
       WHERE m.schematicID = ?
       ORDER BY m.isInput DESC, t.typeName`
    )
    .all(schematicId) as Array<{
      typeID: number;
      typeName: string | null;
      quantity: number;
      isInput: number;
    }>;

  return {
    schematicId: schematic.schematicID,
    schematicName: schematic.schematicName,
    cycleTimeSeconds: schematic.cycleTime,
    inputs: materials
      .filter((material) => material.isInput !== 0)
      .map((material) => ({
        typeId: material.typeID,
        typeName: material.typeName ?? `Unknown(${material.typeID})`,
        quantity: material.quantity,
      })),
    outputs: materials
      .filter((material) => material.isInput === 0)
      .map((material) => ({
        typeId: material.typeID,
        typeName: material.typeName ?? `Unknown(${material.typeID})`,
        quantity: material.quantity,
      })),
  };
}

export function registerPlanetaryTools(server: McpServer): void {
  server.tool(
    "get_planetary_colonies",
    "List the authenticated character's planetary-industry colonies with planet and system names. Requires esi-planets.manage_planets.v1. ESI colony data may remain stale until the colony is viewed in the EVE client.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      requirePlanetaryScope(char.scopes);
      const snapshot = await esiGetWithMetadata<EsiColony[]>(`/characters/${char.characterId}/planets/`, {
        characterId: char.characterId,
      });
      const db = getDatabase();

      const enriched = await Promise.all(
        snapshot.data.map(async (colony) => {
          const planet = await esiGet<EsiPlanetInfo>(`/universe/planets/${colony.planet_id}/`, {
            public: true,
          }).catch(() => null);
          return {
            planetId: colony.planet_id,
            planetName: planet?.name ?? `Planet ${colony.planet_id}`,
            planetType: colony.planet_type,
            planetTypeId: planet?.type_id ?? null,
            solarSystemId: colony.solar_system_id,
            solarSystemName: enrichSystemName(db, colony.solar_system_id),
            commandCenterUpgradeLevel: colony.upgrade_level,
            pinCount: colony.num_pins,
            lastUpdate: colony.last_update,
            colonyLastUpdate: colony.last_update,
          };
        })
      );

      return jsonResult({
        characterName: char.characterName,
        colonyCount: enriched.length,
        ...snapshot.metadata,
        dataFreshnessNote:
          "EVE recalculates planetary colony data only when the colony is viewed in the game client.",
        colonies: enriched,
      });
    }
  );

  server.tool(
    "get_planetary_colony",
    "Get a planetary colony's complete layout: enriched pins, stored materials, extractor programs, factory schematics, links, and routes. Requires esi-planets.manage_planets.v1.",
    {
      planet_id: z.number().int().positive().describe("Planet ID from get_planetary_colonies"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ planet_id, character_id }) => {
      const char = await getActiveCharacter(character_id);
      requirePlanetaryScope(char.scopes);
      const [snapshot, planet, colonyList] = await Promise.all([
        esiGetWithMetadata<EsiColonyLayout>(`/characters/${char.characterId}/planets/${planet_id}/`, {
          characterId: char.characterId,
        }),
        esiGet<EsiPlanetInfo>(`/universe/planets/${planet_id}/`, {
          public: true,
        }).catch(() => null),
        esiGetWithMetadata<EsiColony[]>(`/characters/${char.characterId}/planets/`, { characterId: char.characterId }).catch(() => null),
      ]);
      const layout = snapshot.data;
      const db = getDatabase();

      const pins = layout.pins.map((pin) => {
        const schematicId = pin.factory_details?.schematic_id ?? pin.schematic_id;
        const extractor = pin.extractor_details;
        return {
          pinId: pin.pin_id,
          pinTypeId: pin.type_id,
          pinTypeName: enrichTypeName(db, pin.type_id),
          latitude: pin.latitude,
          longitude: pin.longitude,
          installTime: pin.install_time ?? null,
          expiryTime: pin.expiry_time ?? null,
          lastCycleStart: pin.last_cycle_start ?? null,
          contents: (pin.contents ?? []).map((content) => ({
            typeId: content.type_id,
            typeName: enrichTypeName(db, content.type_id),
            amount: content.amount,
          })),
          extractor: extractor
            ? {
                cycleTimeSeconds: extractor.cycle_time ?? null,
                productTypeId: extractor.product_type_id ?? null,
                productTypeName: extractor.product_type_id
                  ? enrichTypeName(db, extractor.product_type_id)
                  : null,
                quantityPerCycle: extractor.qty_per_cycle ?? null,
                headRadius: extractor.head_radius ?? null,
                heads: extractor.heads,
              }
            : null,
          factorySchematic: schematicId ? getSchematic(schematicId) : null,
        };
      });

      const routes = layout.routes.map((route) => ({
        routeId: route.route_id,
        sourcePinId: route.source_pin_id,
        destinationPinId: route.destination_pin_id,
        contentTypeId: route.content_type_id,
        contentTypeName: enrichTypeName(db, route.content_type_id),
        quantity: route.quantity,
        waypoints: route.waypoints ?? [],
      }));

      return jsonResult({
        characterName: char.characterName,
        planetId: planet_id,
        ...snapshot.metadata,
        colonyLastUpdate: colonyList?.data.find(colony => colony.planet_id === planet_id)?.last_update ?? null,
        colonyListCacheMetadata: colonyList?.metadata ?? null,
        planetName: planet?.name ?? null,
        solarSystemId: planet?.system_id ?? null,
        solarSystemName: planet ? enrichSystemName(db, planet.system_id) : null,
        dataFreshnessNote:
          "EVE recalculates planetary colony data only when the colony is viewed in the game client.",
        pins,
        links: layout.links.map((link) => ({
          sourcePinId: link.source_pin_id,
          destinationPinId: link.destination_pin_id,
          linkLevel: link.link_level,
        })),
        routes,
      });
    }
  );

  server.tool(
    "get_planetary_schematic",
    "Look up planetary-industry factory schematics from the SDE, including cycle time, inputs, and outputs. No ESI authentication required.",
    {
      schematic_id: z.number().int().positive().optional().describe("Planetary schematic ID"),
      name: z.string().optional().describe("Schematic/product name or partial name"),
      limit: z.number().int().min(1).max(100).default(25).describe("Maximum matching schematics"),
    },
    async ({ schematic_id, name, limit }) => {
      if (schematic_id !== undefined) {
        const schematic = getSchematic(schematic_id);
        if (!schematic) throw new Error(`Planetary schematic ${schematic_id} was not found.`);
        return jsonResult(schematic);
      }
      if (!name) throw new Error("Provide either schematic_id or name.");

      const rows = getDatabase()
        .prepare(
          `SELECT schematicID
           FROM planetSchematics
           WHERE schematicName LIKE ? ESCAPE '\\'
           ORDER BY schematicName
           LIMIT ?`
        )
        .all(likeContains(name), limit) as Array<{ schematicID: number }>;
      return jsonResult({
        count: rows.length,
        schematics: rows.map((row) => getSchematic(row.schematicID)),
      });
    }
  );
}
