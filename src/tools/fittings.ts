import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGetAll, esiPost, esiDelete, getActiveCharacter } from "../auth/esi-client.js";
import { enrichTypeName, jsonResult } from "../utils.js";

const SLOT_EFFECT_IDS: Record<number, string> = {
  12: "hi",
  13: "med",
  11: "lo",
  2663: "rig",
  3772: "sub",
  6306: "service",
};

interface EsiFitting {
  fitting_id: number;
  name: string;
  description: string;
  ship_type_id: number;
  items: Array<{
    type_id: number;
    flag: string;
    quantity: number;
  }>;
}

interface FittingItem {
  type_id: number;
  flag: string;
  quantity: number;
}

function resolveTypeId(db: ReturnType<typeof getDatabase>, name: string): number | null {
  const trimmed = name.trim();
  let row = db
    .prepare("SELECT typeID FROM invTypes WHERE typeName = ? AND published = 1")
    .get(trimmed) as { typeID: number } | undefined;
  if (row) return row.typeID;
  row = db
    .prepare("SELECT typeID FROM invTypes WHERE typeName = ? COLLATE NOCASE AND published = 1")
    .get(trimmed) as { typeID: number } | undefined;
  if (row) return row.typeID;
  return null;
}

function getSlotType(db: ReturnType<typeof getDatabase>, typeId: number): string | null {
  const effects = db
    .prepare("SELECT effectID FROM dgmTypeEffects WHERE typeID = ?")
    .all(typeId) as { effectID: number }[];

  for (const e of effects) {
    if (SLOT_EFFECT_IDS[e.effectID]) return SLOT_EFFECT_IDS[e.effectID];
  }

  const cat = db
    .prepare(
      `SELECT c.categoryName FROM invTypes t
       JOIN invGroups g ON t.groupID = g.groupID
       JOIN invCategories c ON g.categoryID = c.categoryID
       WHERE t.typeID = ?`
    )
    .get(typeId) as { categoryName: string } | undefined;

  if (cat) {
    if (cat.categoryName === "Drone") return "drone";
    if (cat.categoryName === "Fighter") return "fighter";
    if (cat.categoryName === "Charge") return "cargo";
  }

  return null;
}

interface ParsedEft {
  shipName: string;
  shipTypeId: number;
  fitName: string;
  items: FittingItem[];
  errors: string[];
  warnings: string[];
}

export function parseEftFormat(db: ReturnType<typeof getDatabase>, eft: string): ParsedEft {
  const lines = eft.trim().split("\n").map((l) => l.trim());
  const errors: string[] = [];
  const warnings: string[] = [];
  const items: FittingItem[] = [];

  const headerMatch = lines[0]?.match(/^\[(.+?),\s*(.+)\]$/);
  if (!headerMatch) {
    return { shipName: "", shipTypeId: 0, fitName: "", items: [], warnings, errors: ["Invalid EFT header. Expected: [Ship Name, Fit Name]"] };
  }

  const shipName = headerMatch[1].trim();
  const fitName = headerMatch[2].trim();
  const shipTypeId = resolveTypeId(db, shipName);
  if (!shipTypeId) {
    return { shipName, shipTypeId: 0, fitName, items: [], warnings, errors: [`Ship "${shipName}" not found in SDE`] };
  }

  const slotCounters: Record<string, number> = { hi: 0, med: 0, lo: 0, rig: 0, sub: 0, service: 0 };
  const FLAG_PREFIX: Record<string, string> = {
    hi: "HiSlot",
    med: "MedSlot",
    lo: "LoSlot",
    rig: "RigSlot",
    sub: "SubSystemSlot",
    service: "ServiceSlot",
  };

  // EFT has no cargo label. Only infer fallback cargo after the final fitting
  // section, separated by a blank line (or following a recognized cargo item).
  let lastFittingLine = 0;
  for (let i = 1; i < lines.length; i++) {
    const name = lines[i].split(",")[0].replace(/\s+x\d+$/, "");
    const id = resolveTypeId(db, name);
    const slot = id ? getSlotType(db, id) : null;
    if (lines[i].startsWith("[Empty") || (slot && FLAG_PREFIX[slot])) lastFittingLine = i;
  }
  let cargoSection = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (line === "" || line === "---") {
      if (i > lastFittingLine) cargoSection = true;
      continue;
    }

    if (line.startsWith("[Empty")) continue;

    // EFT format: "Module Name, Loaded Charge" or "Item Name x2" or just "Item Name"
    const commaIdx = line.indexOf(",");
    let modulePart = line;
    let chargePart: string | null = null;

    if (commaIdx !== -1) {
      const beforeComma = line.substring(0, commaIdx).trim();
      const afterComma = line.substring(commaIdx + 1).trim();
      // Only treat as module+charge if both parts resolve to valid types
      // (avoids splitting item names that contain commas, though rare in EVE)
      const beforeId = resolveTypeId(db, beforeComma);
      if (beforeId && afterComma.length > 0) {
        modulePart = beforeComma;
        chargePart = afterComma;
      }
    }

    // Parse "Item Name x2" quantity suffix
    const quantityMatch = modulePart.match(/^(.+?)\s+x(\d+)$/);
    const itemName = quantityMatch ? quantityMatch[1].trim() : modulePart;
    const quantity = quantityMatch ? parseInt(quantityMatch[2], 10) : 1;

    const typeId = resolveTypeId(db, itemName);
    if (!typeId) {
      errors.push(`Item "${itemName}" not found in SDE`);
      continue;
    }

    let slotType = getSlotType(db, typeId);
    if (slotType === "cargo" && i > lastFittingLine) cargoSection = true;
    if (!slotType && cargoSection && i > lastFittingLine) slotType = "cargo";

    if (!slotType) {
      errors.push(`Could not determine slot type for "${itemName}"`);
      warnings.push(`Resolved "${itemName}" (type ${typeId}) but its section is ambiguous; it was not included. Put ordinary cargo in a blank-line-separated section after all fitted modules, or use structured input with flag="Cargo".`);
      continue;
    }

    if (slotType === "drone") {
      items.push({ type_id: typeId, flag: "DroneBay", quantity });
    } else if (slotType === "fighter") {
      items.push({ type_id: typeId, flag: "FighterBay", quantity });
    } else if (slotType === "cargo") {
      items.push({ type_id: typeId, flag: "Cargo", quantity });
    } else {
      const prefix = FLAG_PREFIX[slotType];
      const idx = slotCounters[slotType]!;
      items.push({ type_id: typeId, flag: `${prefix}${idx}`, quantity });
      slotCounters[slotType]!++;
    }

    // Handle loaded charge as a cargo item
    if (chargePart) {
      const chargeQuantityMatch = chargePart.match(/^(.+?)\s+x(\d+)$/);
      const chargeName = chargeQuantityMatch ? chargeQuantityMatch[1].trim() : chargePart;
      const chargeQty = chargeQuantityMatch ? parseInt(chargeQuantityMatch[2], 10) : 1;

      const chargeTypeId = resolveTypeId(db, chargeName);
      if (chargeTypeId) {
        items.push({ type_id: chargeTypeId, flag: "Cargo", quantity: chargeQty });
      } else {
        errors.push(`Charge "${chargeName}" not found in SDE`);
      }
    }
  }

  return { shipName, shipTypeId, fitName, items, errors, warnings };
}

export function registerFittingTools(server: McpServer): void {
  server.tool(
    "get_fittings",
    "Get all saved fittings for the authenticated character, enriched with ship and module names from the SDE.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      ship_name: z.string().optional().describe("Filter fittings by ship name"),
    },
    async ({ character_id, ship_name }) => {
      const char = await getActiveCharacter(character_id);
      const fittings = await esiGetAll<EsiFitting>(
        `/characters/${char.characterId}/fittings/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();
      let enriched = fittings.map((f) => ({
        fittingId: f.fitting_id,
        name: f.name,
        description: f.description,
        shipName: enrichTypeName(db, f.ship_type_id),
        shipTypeId: f.ship_type_id,
        items: f.items.map((item) => ({
          typeName: enrichTypeName(db, item.type_id),
          typeId: item.type_id,
          flag: item.flag,
          quantity: item.quantity,
        })),
      }));

      if (ship_name) {
        enriched = enriched.filter((f) =>
          f.shipName.toLowerCase().includes(ship_name.toLowerCase())
        );
      }

      return jsonResult({ characterName: char.characterName, fittingCount: enriched.length, fittings: enriched });
    }
  );

  server.tool(
    "save_fitting",
    "Save a fitting to the authenticated character's in-game fitting list. Accepts EFT or structured input. Uses the same classification as parse_eft: published non-slot items such as deployables are Cargo in a blank-line-separated section after fitted modules. Unknown names remain errors; partial-save warnings are returned explicitly. Preview with parse_eft first. This is a WRITE operation.",
    {
      eft: z
        .string()
        .optional()
        .describe(
          'EFT format fitting string, e.g.:\n[Rifter, My Fit]\n200mm AutoCannon II\n200mm AutoCannon II\n1MN Afterburner II\nDamage Control II\nSmall Projectile Burst Aerator I'
        ),
      name: z.string().optional().describe("Fitting name (required if not using EFT format)"),
      description: z.string().default("").describe("Fitting description"),
      ship_type_id: z.number().optional().describe("Ship type ID (required if not using EFT format)"),
      items: z
        .array(
          z.object({
            type_id: z.number(),
            flag: z.string(),
            quantity: z.number().default(1),
          })
        )
        .optional()
        .describe("Fitting items array (required if not using EFT format)"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ eft, name, description, ship_type_id, items, character_id }) => {
      const db = getDatabase();
      let fitName: string;
      let fitDescription: string = description;
      let fitShipTypeId: number;
      let fitItems: FittingItem[];
      let warnings: string[] = [];

      if (eft) {
        const parsed = parseEftFormat(db, eft);
        warnings = [...parsed.warnings, ...parsed.errors];
        if (parsed.errors.length > 0 && parsed.items.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to parse EFT format:\n${parsed.errors.join("\n")}`,
              },
            ],
          };
        }

        fitName = name ?? parsed.fitName;
        fitShipTypeId = parsed.shipTypeId;
        fitItems = parsed.items;

        if (parsed.errors.length > 0) {
          process.stderr.write(`Warnings (some items skipped):\n${parsed.errors.join("\n")}\n\n`);
        }
      } else {
        if (!name || !ship_type_id || !items || items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Provide either an EFT format string, or name + ship_type_id + items.",
              },
            ],
          };
        }
        fitName = name;
        fitShipTypeId = ship_type_id;
        fitItems = items;
      }

      const char = await getActiveCharacter(character_id);

      const body = {
        name: fitName,
        description: fitDescription,
        ship_type_id: fitShipTypeId,
        items: fitItems,
      };

      const result = await esiPost<{ fitting_id: number }>(
        `/characters/${char.characterId}/fittings/`,
        body,
        { characterId: char.characterId }
      );

      const itemSummary = fitItems.map((item) => ({
        name: enrichTypeName(db, item.type_id),
        flag: item.flag,
        quantity: item.quantity,
      }));

      return jsonResult({
        success: true,
        fittingId: result.fitting_id,
        name: fitName,
        ship: enrichTypeName(db, fitShipTypeId),
        characterName: char.characterName,
        itemCount: fitItems.length,
        warnings: warnings.length ? warnings : undefined,
        items: itemSummary,
      });
    }
  );

  server.tool(
    "delete_fitting",
    "Delete a saved fitting from the authenticated character. This is a WRITE operation.",
    {
      fitting_id: z.number().describe("The fitting_id to delete (from get_fittings)"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ fitting_id, character_id }) => {
      const char = await getActiveCharacter(character_id);

      await esiDelete(
        `/characters/${char.characterId}/fittings/${fitting_id}/`,
        { characterId: char.characterId }
      );

      return {
        content: [
          {
            type: "text",
            text: `Fitting ${fitting_id} deleted from ${char.characterName}.`,
          },
        ],
      };
    }
  );

  server.tool(
    "parse_eft",
    "Preview EFT using the same classification as save_fitting. Modules, rigs, drones and charges retain their flags. Published non-slot items (deployables, commodities, paste, etc.) are Cargo in a blank-line-separated section after fitted modules. Unknown names remain errors; ambiguous resolved items produce explicit warnings. Does NOT save anything.",
    {
      eft: z.string().describe("EFT format fitting string"),
    },
    async ({ eft }) => {
      const db = getDatabase();
      const parsed = parseEftFormat(db, eft);

      const itemDetails = parsed.items.map((item) => ({
        name: enrichTypeName(db, item.type_id),
        typeId: item.type_id,
        flag: item.flag,
        quantity: item.quantity,
      }));

      return jsonResult({
        shipName: parsed.shipName,
        shipTypeId: parsed.shipTypeId,
        fitName: parsed.fitName,
        itemCount: parsed.items.length,
        items: itemDetails,
        errors: parsed.errors.length > 0 ? parsed.errors : undefined,
        warnings: parsed.warnings.length > 0 ? parsed.warnings : undefined,
        valid: parsed.errors.length === 0 && parsed.items.length > 0,
      });
    }
  );
}
