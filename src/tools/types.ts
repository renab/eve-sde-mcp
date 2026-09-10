import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { likeContains, jsonResult } from "../utils.js";
import { EntityIndex, endpointDiscoveryShape } from "../entities.js";
import { getStateDatabase } from "../persistence.js";

export function registerTypeTools(server: McpServer): void {
  server.tool(
    "search_types",
    "Search Eve Online item types by name. Returns type_id, name, group, and category. Use this to find ships, modules, ammo, drones, etc.",
    {
      query: z.string().describe("Name or partial name to search for"),
      category: z
        .string()
        .optional()
        .describe("Filter by category name (e.g. 'Ship', 'Module', 'Drone', 'Charge')"),
      group: z
        .string()
        .optional()
        .describe("Filter by group name (e.g. 'Frigate', 'Cruiser', 'Energy Weapon')"),
      published_only: z
        .boolean()
        .default(true)
        .describe("Only return published (available in-game) types"),
      limit: z.number().default(25).describe("Max results to return"),
    },
    async ({ query, category, group, published_only, limit }) => {
      const db = getDatabase();
      let sql = `
        SELECT t.typeID, t.typeName, g.groupName, c.categoryName,
               t.mass, t.volume, t.capacity, t.description
        FROM invTypes t
        JOIN invGroups g ON t.groupID = g.groupID
        JOIN invCategories c ON g.categoryID = c.categoryID
        WHERE t.typeName LIKE ? ESCAPE '\\'
      `;
      const params: unknown[] = [likeContains(query)];

      if (published_only) {
        sql += " AND t.published = 1";
      }
      if (category) {
        sql += " AND c.categoryName LIKE ? ESCAPE '\\'";
        params.push(likeContains(category));
      }
      if (group) {
        sql += " AND g.groupName LIKE ? ESCAPE '\\'";
        params.push(likeContains(group));
      }
      sql += " ORDER BY t.typeName LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params);
      return jsonResult(rows);
    }
  );

  server.tool(
    "get_type",
    "Get full details for an Eve Online type by ID, including all dogma attributes (CPU, powergrid, damage, resistances, etc.), effects, traits, and meta info.",
    {
      ...endpointDiscoveryShape,
      type_id: z.number().describe("The typeID to look up"),
    },
    async ({ type_id, include_related, record_namespace, related_limit }) => {
      const db = getDatabase();

      const typeInfo = db
        .prepare(
          `SELECT t.*, g.groupName, c.categoryName
           FROM invTypes t
           JOIN invGroups g ON t.groupID = g.groupID
           JOIN invCategories c ON g.categoryID = c.categoryID
           WHERE t.typeID = ?`
        )
        .get(type_id);

      if (!typeInfo) {
        return { content: [{ type: "text", text: `Type ${type_id} not found.` }] };
      }

      const attributes = db
        .prepare(
          `SELECT a.attributeName, a.displayName, ta.valueInt, ta.valueFloat,
                  a.unitID, u.displayName as unitName
           FROM dgmTypeAttributes ta
           JOIN dgmAttributeTypes a ON ta.attributeID = a.attributeID
           LEFT JOIN eveUnits u ON a.unitID = u.unitID
           WHERE ta.typeID = ?
           ORDER BY a.categoryID, a.attributeName`
        )
        .all(type_id);

      const effects = db
        .prepare(
          `SELECT e.effectName, e.displayName, e.description, te.isDefault
           FROM dgmTypeEffects te
           JOIN dgmEffects e ON te.effectID = e.effectID
           WHERE te.typeID = ?`
        )
        .all(type_id);

      const traits = db
        .prepare(`SELECT * FROM invTraits WHERE typeID = ?`)
        .all(type_id);

      const metaInfo = db
        .prepare(
          `SELECT mt.parentTypeID, mg.metaGroupName
           FROM invMetaTypes mt
           JOIN invMetaGroups mg ON mt.metaGroupID = mg.metaGroupID
           WHERE mt.typeID = ?`
        )
        .get(type_id);

      const result = { type: typeInfo, attributes, effects, traits, meta: metaInfo || null };
      return jsonResult({ ...result, ...(include_related ? new EntityIndex(getStateDatabase()).related({ namespace: record_namespace,
        entity_refs: [{ type: "type", id: String(type_id) }], limit: related_limit }) : {}) });
    }
  );

  server.tool(
    "get_type_attributes",
    "Get all dogma attributes for a type, with human-readable names and units. Essential for fitting: CPU, powergrid, capacitor, damage, tracking speed, signature radius, resistances, etc.",
    {
      type_id: z.number().describe("The typeID"),
      filter: z
        .string()
        .optional()
        .describe(
          "Optional filter on attribute name (e.g. 'damage', 'cpu', 'power', 'resist', 'capacity')"
        ),
    },
    async ({ type_id, filter }) => {
      const db = getDatabase();
      let sql = `
        SELECT a.attributeID, a.attributeName, a.displayName, a.description,
               COALESCE(ta.valueFloat, ta.valueInt) as value,
               u.displayName as unit
        FROM dgmTypeAttributes ta
        JOIN dgmAttributeTypes a ON ta.attributeID = a.attributeID
        LEFT JOIN eveUnits u ON a.unitID = u.unitID
        WHERE ta.typeID = ?
      `;
      const params: unknown[] = [type_id];

      if (filter) {
        sql += " AND (a.attributeName LIKE ? ESCAPE '\\' OR a.displayName LIKE ? ESCAPE '\\')";
        params.push(likeContains(filter), likeContains(filter));
      }
      sql += " ORDER BY a.categoryID, a.attributeName";

      const rows = db.prepare(sql).all(...params);
      return jsonResult(rows);
    }
  );

  server.tool(
    "get_type_effects",
    "Get effects for a type — determines slot type (hiSlot, medSlot, loSlot, rigSlot), activation effects, passive bonuses, etc.",
    {
      type_id: z.number().describe("The typeID"),
    },
    async ({ type_id }) => {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT e.effectID, e.effectName, e.displayName, e.description,
                  e.effectCategory, te.isDefault
           FROM dgmTypeEffects te
           JOIN dgmEffects e ON te.effectID = e.effectID
           WHERE te.typeID = ?
           ORDER BY e.effectName`
        )
        .all(type_id);
      return jsonResult(rows);
    }
  );

  server.tool(
    "compare_types",
    "Compare dogma attributes side-by-side for multiple types. Useful for comparing ships or modules.",
    {
      type_ids: z.array(z.number()).min(2).max(10).describe("List of typeIDs to compare"),
      attributes: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of attribute names to compare. If omitted, returns all shared attributes."
        ),
    },
    async ({ type_ids, attributes }) => {
      const db = getDatabase();

      const typeNames: Record<number, string> = {};
      for (const id of type_ids) {
        const row = db
          .prepare("SELECT typeName FROM invTypes WHERE typeID = ?")
          .get(id) as { typeName: string } | undefined;
        typeNames[id] = row?.typeName ?? `Unknown(${id})`;
      }

      const placeholders = type_ids.map(() => "?").join(",");
      let sql = `
        SELECT ta.typeID, a.attributeName, a.displayName,
               COALESCE(ta.valueFloat, ta.valueInt) as value,
               u.displayName as unit
        FROM dgmTypeAttributes ta
        JOIN dgmAttributeTypes a ON ta.attributeID = a.attributeID
        LEFT JOIN eveUnits u ON a.unitID = u.unitID
        WHERE ta.typeID IN (${placeholders})
      `;
      const params: unknown[] = [...type_ids];

      if (attributes && attributes.length > 0) {
        const attrPlaceholders = attributes.map(() => "?").join(",");
        sql += ` AND (a.attributeName IN (${attrPlaceholders}) OR a.displayName IN (${attrPlaceholders}))`;
        params.push(...attributes, ...attributes);
      }
      sql += " ORDER BY a.attributeName, ta.typeID";

      const rows = db.prepare(sql).all(...params) as {
        typeID: number;
        attributeName: string;
        displayName: string;
        value: number;
        unit: string;
      }[];

      const comparison: Record<string, Record<string, { value: number; unit: string }>> = {};
      for (const row of rows) {
        const attrKey = row.displayName || row.attributeName;
        if (!comparison[attrKey]) comparison[attrKey] = {};
        comparison[attrKey][typeNames[row.typeID]] = { value: row.value, unit: row.unit };
      }

      return jsonResult({ types: typeNames, comparison });
    }
  );
}
