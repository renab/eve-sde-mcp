import { structureIdSchema } from "../structures.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, esiGetAll, getActiveCharacter } from "../auth/esi-client.js";
import { walletJournalPath,walletTransactionsPath } from "../esi-datasets.js";
import { enrichTypeName, jsonResult } from "../utils.js";

interface EsiOrder {
  order_id: number;
  type_id: number;
  location_id: number;
  volume_total: number;
  volume_remain: number;
  price: number;
  is_buy_order: boolean;
  issued: string;
  duration: number;
  min_volume?: number;
  range?: string;
  region_id?: number;
  escrow?: number;
  state?: string;
}

interface EsiWalletJournalEntry {
  id: number;
  date: string;
  ref_type: string;
  amount?: number;
  balance?: number;
  description: string;
  first_party_id?: number;
  second_party_id?: number;
  reason?: string;
  context_id?: number;
  context_id_type?: string;
}

interface EsiTransaction {
  transaction_id: number;
  date: string;
  type_id: number;
  quantity: number;
  unit_price: number;
  client_id: number;
  location_id: number;
  is_buy: boolean;
  is_personal: boolean;
  journal_ref_id: number;
}

const JITA_TRADE_HUB = 60003760;
const MAX_CONCURRENT_ESI = 10;

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

export function registerMarketTools(server: McpServer): void {
  server.tool(
    "get_wallet_balance",
    "Get the ISK wallet balance for the authenticated character.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const balance = await esiGet<number>(
        `/characters/${char.characterId}/wallet/`,
        { characterId: char.characterId }
      );
      return jsonResult({
        characterName: char.characterName,
        balance,
        formatted: balance.toLocaleString("en-US", { minimumFractionDigits: 2 }) + " ISK",
      });
    }
  );

  server.tool(
    "get_character_orders",
    "Get open market orders for the authenticated character, enriched with item names from the SDE. Supports filtering by item, side, and location.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type_id: z.number().optional().describe("Filter to a specific item type ID"),
      side: z.enum(["buy", "sell"]).optional().describe("Filter to buy or sell orders only"),
      location_id: structureIdSchema.optional().describe("Filter to a specific station/structure (e.g. 60003760 = Jita 4-4)"),
    },
    async ({ character_id, type_id, side, location_id }) => {
      const char = await getActiveCharacter(character_id);
      let orders = await esiGet<EsiOrder[]>(
        `/characters/${char.characterId}/orders/`,
        { characterId: char.characterId }
      );

      if (type_id) orders = orders.filter((o) => o.type_id === type_id);
      if (side) orders = orders.filter((o) => side === "buy" ? o.is_buy_order : !o.is_buy_order);
      if (location_id) orders = orders.filter((o) => String(o.location_id) === String(location_id));

      const db = getDatabase();
      const enriched = orders.map((o) => ({
        orderId: o.order_id,
        typeName: enrichTypeName(db, o.type_id),
        typeId: o.type_id,
        isBuyOrder: o.is_buy_order,
        price: o.price,
        volumeRemain: o.volume_remain,
        volumeTotal: o.volume_total,
        locationId: o.location_id,
        issued: o.issued,
        duration: o.duration,
        minVolume: o.min_volume,
        range: o.range,
        escrow: o.escrow,
      }));

      const buyOrders = enriched.filter((o) => o.isBuyOrder);
      const sellOrders = enriched.filter((o) => !o.isBuyOrder);

      return jsonResult({
        characterName: char.characterName,
        totalOrders: enriched.length,
        buyOrders: buyOrders.length,
        sellOrders: sellOrders.length,
        orders: enriched,
      });
    }
  );

  server.tool(
    "get_order_history",
    "Get historical (completed/cancelled/expired) market orders for the authenticated character. Supports filtering by item, state, side, location, and date to avoid returning the full 90-day history.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type_id: z.number().optional().describe("Filter to a specific item type ID"),
      state: z.enum(["expired", "cancelled", "fulfilled"]).optional().describe("Filter by order state"),
      side: z.enum(["buy", "sell"]).optional().describe("Filter to buy or sell orders only"),
      location_id: structureIdSchema.optional().describe("Filter to a specific station/structure (e.g. 60003760 = Jita 4-4)"),
      issued_after: z.string().optional().describe("Only return orders issued after this ISO date (e.g. '2026-07-01')"),
    },
    async ({ character_id, type_id, state, side, location_id, issued_after }) => {
      const char = await getActiveCharacter(character_id);
      let orders = await esiGetAll<EsiOrder & { state: string }>(
        `/characters/${char.characterId}/orders/history/`,
        { characterId: char.characterId }
      );

      if (type_id) orders = orders.filter((o) => o.type_id === type_id);
      if (state) orders = orders.filter((o) => o.state === state);
      if (side) orders = orders.filter((o) => side === "buy" ? o.is_buy_order : !o.is_buy_order);
      if (location_id) orders = orders.filter((o) => String(o.location_id) === String(location_id));
      if (issued_after) {
        const cutoff = new Date(issued_after).getTime();
        orders = orders.filter((o) => new Date(o.issued).getTime() >= cutoff);
      }

      const db = getDatabase();
      const enriched = orders.map((o) => ({
        orderId: o.order_id,
        typeName: enrichTypeName(db, o.type_id),
        typeId: o.type_id,
        isBuyOrder: o.is_buy_order,
        price: o.price,
        volumeRemain: o.volume_remain,
        volumeTotal: o.volume_total,
        state: o.state,
        locationId: o.location_id,
        regionId: o.region_id,
        issued: o.issued,
      }));

      return jsonResult({ characterName: char.characterName, count: enriched.length, orders: enriched });
    }
  );

  server.tool(
    "get_wallet_journal",
    "Get the wallet journal (ISK income/expenses log) for the authenticated character. Supports filtering by ref_type and date. Common ref_types for trading: 'brokers_fee', 'transaction_tax', 'market_transaction'.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      ref_type: z.string().optional().describe("Filter by ref_type (e.g. 'brokers_fee', 'transaction_tax', 'market_transaction')"),
      since: z.string().optional().describe("Only return entries after this ISO date (e.g. '2026-07-01')"),
    },
    async ({ character_id, ref_type, since }) => {
      const char = await getActiveCharacter(character_id);
      let journal = await esiGetAll<EsiWalletJournalEntry>(
        walletJournalPath(char.characterId),
        { characterId: char.characterId }
      );

      if (ref_type) journal = journal.filter((e) => e.ref_type === ref_type);
      if (since) {
        const cutoff = new Date(since).getTime();
        journal = journal.filter((e) => new Date(e.date).getTime() >= cutoff);
      }

      return jsonResult({ characterName: char.characterName, entries: journal.length, journal });
    }
  );

  server.tool(
    "get_wallet_transactions",
    "Get recent wallet transactions (market buys/sells) for the authenticated character, enriched with item names. Supports filtering by item, side, location, and date.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      type_id: z.number().optional().describe("Filter to a specific item type ID"),
      side: z.enum(["buy", "sell"]).optional().describe("Filter to buy or sell transactions only"),
      location_id: structureIdSchema.optional().describe("Filter to a specific station/structure (e.g. 60003760 = Jita 4-4)"),
      since: z.string().optional().describe("Only return transactions after this ISO date (e.g. '2026-07-01')"),
    },
    async ({ character_id, type_id, side, location_id, since }) => {
      const char = await getActiveCharacter(character_id);
      let transactions = await esiGet<EsiTransaction[]>(
        walletTransactionsPath(char.characterId),
        { characterId: char.characterId }
      );

      if (type_id) transactions = transactions.filter((t) => t.type_id === type_id);
      if (side) transactions = transactions.filter((t) => side === "buy" ? t.is_buy : !t.is_buy);
      if (location_id) transactions = transactions.filter((t) => String(t.location_id) === String(location_id));
      if (since) {
        const cutoff = new Date(since).getTime();
        transactions = transactions.filter((t) => new Date(t.date).getTime() >= cutoff);
      }

      const db = getDatabase();
      const enriched = transactions.map((t) => ({
        transactionId: t.transaction_id,
        date: t.date,
        typeName: enrichTypeName(db, t.type_id),
        typeId: t.type_id,
        quantity: t.quantity,
        unitPrice: t.unit_price,
        total: t.quantity * t.unit_price,
        isBuy: t.is_buy,
        locationId: t.location_id,
        clientId: t.client_id,
      }));

      return jsonResult({ characterName: char.characterName, count: enriched.length, transactions: enriched });
    }
  );

  server.tool(
    "get_market_prices",
    "Get the global average and adjusted prices for all items in Eve Online (public, no auth needed).",
    {
      type_id: z.number().optional().describe("Filter to a specific type ID"),
    },
    async ({ type_id }) => {
      const prices = await esiGet<Array<{ type_id: number; average_price?: number; adjusted_price?: number }>>(
        "/markets/prices/",
        { public: true }
      );

      const db = getDatabase();

      if (type_id) {
        const match = prices.find((p) => p.type_id === type_id);
        if (!match) {
          return { content: [{ type: "text", text: `No price data for type ${type_id}.` }] };
        }
        return jsonResult({ ...match, typeName: enrichTypeName(db, match.type_id) });
      }

      return jsonResult({ count: prices.length, note: "Use type_id parameter to filter. Full list is ~13k items." });
    }
  );

  server.tool(
    "get_region_orders",
    "Get market orders for a specific item in a region (public, no auth needed). Use for price checking. Set location_id to filter to a specific station (e.g. 60003760 for Jita 4-4 CNAP).",
    {
      region_id: z.number().describe("Region ID (10000002 = The Forge/Jita, 10000043 = Domain/Amarr)"),
      type_id: z.number().describe("Type ID of the item"),
      order_type: z.enum(["buy", "sell", "all"]).default("all").describe("Filter by order type"),
      location_id: structureIdSchema.optional().describe("Filter to a specific station/structure (e.g. 60003760 = Jita 4-4 CNAP)"),
    },
    async ({ region_id, type_id, order_type, location_id }) => {
      let url = `/markets/${region_id}/orders/?type_id=${type_id}`;
      if (order_type === "buy") url += "&order_type=buy";
      else if (order_type === "sell") url += "&order_type=sell";
      else url += "&order_type=all";

      let orders = await esiGetAll<EsiOrder>(url, { public: true });

      if (location_id) {
        orders = orders.filter((o) => String(o.location_id) === String(location_id));
      }

      const db = getDatabase();
      const typeName = enrichTypeName(db, type_id);

      const buyOrders = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
      const sellOrders = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);

      return jsonResult({
        typeName,
        typeId: type_id,
        regionId: region_id,
        ...(location_id ? { locationId: location_id } : {}),
        bestBuy: buyOrders[0]?.price ?? null,
        bestSell: sellOrders[0]?.price ?? null,
        spread: buyOrders[0] && sellOrders[0]
          ? ((sellOrders[0].price - buyOrders[0].price) / sellOrders[0].price * 100).toFixed(2) + "%"
          : null,
        buyOrderCount: buyOrders.length,
        sellOrderCount: sellOrders.length,
        topBuyOrders: buyOrders.slice(0, 5),
        topSellOrders: sellOrders.slice(0, 5),
      });
    }
  );

  server.tool(
    "get_market_history",
    "Get daily price/volume history for an item in a region (public, no auth needed).",
    {
      region_id: z.number().describe("Region ID (10000002 = The Forge/Jita)"),
      type_id: z.number().describe("Type ID of the item"),
      days: z.number().default(30).describe("Number of recent days to return"),
    },
    async ({ region_id, type_id, days }) => {
      const history = await esiGet<Array<{
        date: string;
        average: number;
        highest: number;
        lowest: number;
        order_count: number;
        volume: number;
      }>>(`/markets/${region_id}/history/?type_id=${type_id}`, { public: true });

      const db = getDatabase();
      const typeName = enrichTypeName(db, type_id);
      const recent = history.slice(-days);

      return jsonResult({ typeName, typeId: type_id, regionId: region_id, days: recent.length, history: recent });
    }
  );

  server.tool(
    "get_structure_orders",
    "Get market orders in a player-owned structure (citadel, engineering complex, etc.). Requires esi-markets.structure_markets.v1 scope and docking access.",
    {
      structure_id: z.string().regex(/^\d+$/).describe("Structure ID (numeric string — 64-bit IDs exceed JS number precision). Find from assets or in-game."),
      type_id: z.number().optional().describe("Filter to a specific type ID"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ structure_id, type_id, character_id }) => {
      const char = await getActiveCharacter(character_id);
      const orders = await esiGetAll<EsiOrder>(
        `/markets/structures/${structure_id}/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();
      let filtered = orders;
      if (type_id) {
        filtered = orders.filter((o) => o.type_id === type_id);
      }

      const enriched = filtered.map((o) => ({
        orderId: o.order_id,
        typeName: enrichTypeName(db, o.type_id),
        typeId: o.type_id,
        isBuyOrder: o.is_buy_order,
        price: o.price,
        volumeRemain: o.volume_remain,
        volumeTotal: o.volume_total,
        issued: o.issued,
        duration: o.duration,
        minVolume: o.min_volume,
        range: o.range,
      }));

      const buyOrders = enriched.filter((o) => o.isBuyOrder).sort((a, b) => b.price - a.price);
      const sellOrders = enriched.filter((o) => !o.isBuyOrder).sort((a, b) => a.price - b.price);

      return jsonResult({
        characterName: char.characterName,
        structureId: structure_id,
        totalOrders: enriched.length,
        buyOrders: buyOrders.length,
        sellOrders: sellOrders.length,
        bestBuy: buyOrders[0]?.price ?? null,
        bestSell: sellOrders[0]?.price ?? null,
        orders: enriched,
      });
    }
  );

  server.tool(
    "get_market_types",
    "List all type IDs with active market orders in a region (public). Useful for finding what's traded in a region.",
    {
      region_id: z.number().describe("Region ID (10000002 = The Forge/Jita)"),
    },
    async ({ region_id }) => {
      const typeIds = await esiGetAll<number>(
        `/markets/${region_id}/types/`,
        { public: true }
      );

      return jsonResult({ regionId: region_id, typeCount: typeIds.length, typeIds });
    }
  );

  server.tool(
    "get_portfolio_margins",
    "Fetch market data for multiple items in parallel and calculate margins. Optimized for reviewing station trading positions — fetches all items concurrently and filters to a specific station. Returns best buy/sell prices, spread, and margin after taxes for each item.",
    {
      type_ids: z.array(z.number()).describe("Array of type IDs to check"),
      region_id: z.number().default(10000002).describe("Region ID (default: 10000002 = The Forge)"),
      location_id: structureIdSchema.default(JITA_TRADE_HUB).describe("Station/structure to filter orders to (default: 60003760 = Jita 4-4 CNAP)"),
      sales_tax_pct: z.number().default(3.6).describe("Sales tax percentage (default 3.6% for Accounting V + no standings)"),
      broker_fee_pct: z.number().default(1.0).describe("Broker fee percentage (default 1.0% for Broker Relations V + no standings)"),
    },
    async ({ type_ids, region_id, location_id, sales_tax_pct, broker_fee_pct }) => {
      const db = getDatabase();

      const results = await mapConcurrent(
        type_ids,
        MAX_CONCURRENT_ESI,
        async (type_id) => {
          const url = `/markets/${region_id}/orders/?type_id=${type_id}&order_type=all`;
          try {
            const allOrders = await esiGetAll<EsiOrder>(url, { public: true });
            const orders = allOrders.filter((o) => String(o.location_id) === String(location_id));

            const buyOrders = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
            const sellOrders = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);

            const bestBuy = buyOrders[0]?.price ?? null;
            const bestSell = sellOrders[0]?.price ?? null;

            let margin = null;
            let profitPerUnit = null;
            if (bestBuy !== null && bestSell !== null) {
              const buyTotal = bestBuy * (1 + broker_fee_pct / 100);
              const sellNet = bestSell * (1 - sales_tax_pct / 100 - broker_fee_pct / 100);
              profitPerUnit = sellNet - buyTotal;
              margin = ((profitPerUnit / buyTotal) * 100);
            }

            return {
              typeId: type_id,
              typeName: enrichTypeName(db, type_id),
              bestBuy,
              bestSell,
              spread: bestBuy && bestSell
                ? ((bestSell - bestBuy) / bestSell * 100)
                : null,
              margin,
              profitPerUnit,
              buyOrderCount: buyOrders.length,
              sellOrderCount: sellOrders.length,
            };
          } catch (err) {
            return {
              typeId: type_id,
              typeName: enrichTypeName(db, type_id),
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      );

      const successful = results.filter((r) => !("error" in r));
      const sorted = successful.sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity));

      return jsonResult({
        locationId: location_id,
        regionId: region_id,
        salesTaxPct: sales_tax_pct,
        brokerFeePct: broker_fee_pct,
        itemCount: results.length,
        items: sorted,
        errors: results.filter((r) => "error" in r),
      });
    }
  );
}
