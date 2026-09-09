# eve-sde-mcp

MCP server providing access to Eve Online's Static Data Export (SDE) and live character data via the ESI API — ship stats, module attributes, universe data, industry blueprints, character skills, and more.

Static data is powered by the [Fuzzwork](https://www.fuzzwork.co.uk/dump/) SQLite conversion of CCP's SDE. Live data uses EVE SSO OAuth with PKCE (no client secret needed).

## Tools

### Static Data (SDE)

| Tool | Description |
|------|-------------|
| `search_types` | Search items by name with category/group filters |
| `get_type` | Full type detail with dogma attributes, effects, and traits |
| `get_type_attributes` | Dogma attributes (CPU, PG, damage, resists, etc.) |
| `get_type_effects` | Effects and slot type (hi/med/low/rig) |
| `compare_types` | Side-by-side attribute comparison for multiple types |
| `get_group` | Inventory group with all types |
| `get_category` | Inventory category with child groups |
| `get_market_group` | Market group tree navigation |
| `search_systems` | Search solar systems by name |
| `get_system` | System details, connected systems, stations |
| `get_region` | Region with constellations |
| `get_station` | Station details |
| `get_blueprint` | Blueprint materials, products, skills, time |
| `search_blueprints` | Find blueprints by product name |
| `query_sde` | Raw read-only SQL against the SDE |
| `get_sde_status` | SDE version, download date, table list |
| `refresh_sde` | Download/update the SDE from Fuzzwork |

### Live Character Data (ESI)

| Tool | Description |
|------|-------------|
| `esi_login` | Start EVE SSO OAuth login flow |
| `esi_status` | Show authenticated characters and token status |
| `esi_logout` | Remove stored tokens for a character |
| `esi_switch_character` | Switch active character for queries |
| `get_character_skills` | All trained skills with SDE-enriched names and groups |
| `get_skill_queue` | Current skill training queue |
| `get_character_attributes` | Character attributes (int/mem/per/will/cha) |
| `check_skill_requirements` | Check if character meets skill reqs for a ship/module |
| `get_loyalty_points` | Current LP wallet balances by NPC corporation |
| `get_loyalty_point_activity` | LP gains/spending observed between MCP balance polls |

LP balance polls bypass the MCP's local ESI cache so activity tracking relies
only on the upstream ESI cache. Upstream caching can still delay when an in-game
LP change becomes visible to the tools.

### Market & Trading (ESI)

| Tool | Description |
|------|-------------|
| `get_wallet_balance` | Character ISK balance |
| `get_character_orders` | Open market orders with item names |
| `get_order_history` | Completed/cancelled/expired orders |
| `get_wallet_journal` | ISK income/expense log |
| `get_wallet_transactions` | Recent market buys/sells with item names |
| `get_market_prices` | Global average/adjusted prices (public) |
| `get_region_orders` | Market orders for an item in a region (public) |
| `get_market_history` | Daily price/volume history for an item (public) |
| `get_structure_orders` | Orders in a player-owned structure (authenticated) |
| `get_market_types` | List type IDs with active orders in a region (public) |

### Killmails (ESI)

| Tool | Description |
|------|-------------|
| `get_recent_killmails` | Character's recent kills and losses (IDs + hashes) |
| `get_killmail` | Full killmail detail with victim fitting, attackers, SDE names (public) |

### Fittings (ESI)

| Tool | Description |
|------|-------------|
| `get_fittings` | All saved fittings with ship/module names from SDE |
| `save_fitting` | Save a fitting from EFT format or structured input (write) |
| `delete_fitting` | Delete a saved fitting by ID (write) |
| `parse_eft` | Preview EFT parsing without saving — resolves names to IDs and slot flags |

### Industry & Assets (ESI)

| Tool | Description |
|------|-------------|
| `get_industry_jobs` | Active/recent manufacturing, research, invention jobs |
| `get_industry_cost_indices` | System cost indices for industry (public) |
| `get_character_assets` | Items in hangars/containers with names |
| `get_corporation_assets` | Corporation assets visible to a Director, with names and filters |
| `set_autopilot_destination` | Set an in-game autopilot destination or waypoint |
| `get_route` | Calculate routes between system names/IDs: ESI shorter/safer/less_secure, or shortest SDE highsec_only; named/ID avoidance, ordered names/security and route security summary; does not read or change the client route |
| `get_planetary_colonies` | List a character's planetary-industry colonies |
| `get_planetary_colony` | Read pins, factories, extractors, links, and routes for one colony |
| `get_planetary_schematic` | Look up PI schematic inputs, outputs, and cycle time |

`get_route({origin: "Aphi", destination: "Jita", preference: "highsec_only"})`
minimizes stargate jumps in the installed SDE, excluding systems with raw security
below 0.45. It does not use ESI's weighted `safer` preference. Its `source` identifies
the local calculation: results depend on the installed SDE's gate topology, exclude
wormholes/jump bridges, and are not live gate-availability or safety guarantees.
Refresh the SDE when topology changes. Both endpoints must be highsec; no valid path
or an avoided endpoint produces an error, never a lowsec fallback. `security_penalty`
is ignored for this preference. Existing preferences still use ESI unchanged.
`avoid_systems` accepts IDs and exact case-insensitive names and returns deduplicated
IDs in `avoidSystems`.

Route security counts include origin and destination. `minimumSecurity` is raw;
`displaySecurity` is rounded to one decimal (positive values display at least 0.1).
Classification uses raw security: highsec >= 0.45, lowsec > 0 and < 0.45, nullsec <= 0,
as described in the [EVE security guide](https://developers.eveonline.com/docs/guides/system-security/).
Missing security yields null per-system enrichment and increments
`unknownSecuritySystemCount`; the minimum and otherwise-false containment flags
are null when unknown systems prevent a complete answer.

PI list and detail responses expose `esiFetchedAt`, `esiDate`, `esiLastModified`,
`esiExpiresAt`, `esiETag`, `esiCacheControl`, `esiAge`, `localCacheExpiresAt`, and
`cacheStatus` (`esi_response` or `local_hit`). Missing ESI headers are null.
The PI cache uses upstream freshness headers, including Age, rather than a fixed
ten-minute local TTL. `colonyLastUpdate` is the colony-list value, not the HTTP
fetch time; details include separate `colonyListCacheMetadata`. Contents remain
under `pins[].contents`. A fresh HTTP response does not prove the game recalculated
the colony; cache metadata and unchanged quantities alone cannot prove a server bug.
| `get_character_location` | Current solar system and docked location |
| `get_character_ship` | Current ship type, item ID, and name |
| `get_character_clones` | Home station, jump clones and their implants |
| `get_character_implants` | Active-clone implants with names |
| `get_character_mining` | Available 30-day mining ledger with ore/system names |
| `get_character_blueprints` | Owned blueprints, research levels, runs and locations |
| `get_contract_items` | Included/requested items in a character contract |
| `get_loyalty_store_offers` | LP/ISK/item costs and output quantities for LP store offers |
| `get_character_standings` | Agent, corporation and faction standings |
| `get_character_notifications` | Game notifications, newest first |
| `get_character_roles` | Character corporation roles |
| `get_character_asset_names`, `get_character_asset_locations` | Custom asset names and coordinates |
| `get_corporation_asset_names`, `get_corporation_asset_locations` | Corporation asset names and coordinates (Director) |
| `get_structure` | Accessible player structure name, owner and system |
| `get_corporation_wallets` | Corporation wallet division balances |
| `get_corporation_wallet_journal`, `get_corporation_wallet_transactions` | Division journal and transactions (division 1–7 required) |
| `get_corporation_blueprints` | Blueprint research levels and runs (Director) |
| `get_corporation_industry_jobs` | Jobs, optionally completed (Factory Manager) |
| `get_corporation_structures` | Structure state, fuel and service details (Station Manager) |
| `get_system_jumps`, `get_system_kills` | Historical system activity, optionally filtered by system |
| `get_sovereignty_map`, `get_sovereignty_campaigns`, `get_sovereignty_structures` | Ownership, campaigns and vulnerability information |
| `get_incursions` | Active incursions and affected systems |

Corporation wallet reads require Accountant or Junior Accountant access. Corporation
IDs default to the selected character's current corporation. ESI enforces roles and
structure access. New operational tools are read-only, preserve ESI response fields,
and add type/system names where available. Lists support `limit`/`offset`; public
activity and sovereignty tools also accept `system_id`. ESI's upstream cache applies;
system activity is historical and does not establish whether a route is safe.

New ESI capabilities require running `esi_login` again for each character whose
stored token lacks the required scopes. Enable these scopes on the EVE developer
application as well. Refresh tokens cannot acquire additional scopes themselves.
All ESI GET tools share a cache governed solely by upstream freshness headers:
Cache-Control/max-age (accounting for Age and Date), or Expires when max-age is
absent. Missing freshness information, no-cache, and no-store prevent reuse.
There are no fixed local TTLs. Each paginated response page retains its own expiry;
expired pages are fetched again without checking layout or Last-Modified values.
Private responses are isolated by authentication context, and authentication is
checked before cache hits. Successful fitting/UI writes and deletes invalidate
local cached reads. ESI may still return its own cached representation afterward.
Ledger, blueprint and contract-item results support `type_id`, `limit` and `offset`.
| `get_character_contracts` | Courier, item exchange, auction contracts |

## Setup

Requires Node.js 20+.

```bash
git clone https://github.com/ramonvanalteren/eve-sde-mcp.git
cd eve-sde-mcp
npm install
npm run build
```

The SDE database (~460MB) is auto-downloaded to `~/.eve-sde/eve.db` on first run.

## Claude Desktop / Claude Chat

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eve-sde": {
      "command": "node",
      "args": ["/path/to/eve-sde-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop to connect.

## Remote HTTP Bridge (ChatGPT)

The server also provides a stateless Streamable HTTP endpoint suitable for a
ChatGPT MCP connector. It listens on loopback by default. Authentication for a
remote deployment is enforced at the Cloudflare Access layer, matching the
Sweetwater MCP deployment; the local origin does not implement authentication.

```powershell
Copy-Item .env.example .env
npm install
npm run build
npm run start:http
```

Endpoints:

- `GET /health` — unauthenticated, minimal health probe
- `POST /mcp` — authenticated MCP Streamable HTTP endpoint

The bridge writes structured JSON access logs to stdout for PM2. MCP request
entries contain the JSON-RPC method, tool name, and complete arguments; matching
response entries contain the HTTP status and duration. Request headers are not
logged, keeping OAuth bearer tokens and Cloudflare credentials out of the log.
View recent activity with `pm2 logs eve-sde-mcp --lines 100 --nostream`.

### Persistent Windows deployment

1. Install PM2 and its Windows service integration from an elevated terminal.
2. Build the project, create `.env`, then register and persist the process:

   ```powershell
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 logs eve-sde-mcp
   ```

3. Configure the PM2 Windows service to run under the same Windows account. This
   matters because the SDE, EVE SSO configuration, and encrypted character tokens
   live in that account's `%USERPROFILE%\.eve-sde` directory.
4. Create a named Cloudflare Tunnel whose public hostname routes to
   `http://127.0.0.1:3001`. A configuration template is provided at
   `deploy/cloudflared-config.yml.example`. Install `cloudflared` as a Windows
   service so the tunnel survives logout and reboot.
5. Protect the public hostname with a Cloudflare Access policy, then use
   `https://YOUR_HOSTNAME/mcp` as the MCP URL in ChatGPT.

Keep `.env`, the tunnel credentials JSON, and Cloudflare service tokens out of
Git. Leave the origin bound to `127.0.0.1`; Cloudflare Tunnel does not require a
public firewall port. Do not publish the origin directly: Cloudflare Access is
the authentication boundary for this deployment.

## ESI Authentication

To use the live character data tools, you need an EVE SSO application:

1. Register at https://developers.eveonline.com — create an app with "Authentication & API Access", callback URL `http://localhost:8085/callback`
2. Create `~/.eve-sde/config.json`:
   ```json
   { "clientId": "your_client_id_here" }
   ```
3. Use the `esi_login` tool. It immediately returns an EVE SSO authorization URL.
4. Open that URL on the Windows machine running the MCP within five minutes, approve the scopes, and select a character. EVE redirects the local browser to `http://localhost:8085/callback` and the MCP stores the tokens in the background.
5. Use `esi_status` to confirm that authentication succeeded.

Tokens are encrypted at rest (AES-256-GCM) and stored in `~/.eve-sde/auth.db`. Scopes include skill reading, wallet, market, industry, planetary industry, character and corporation assets, contracts, fittings (read+write), and autopilot waypoint updates. Corporation assets require the authenticated character to have the Director role. ESI exposes planetary industry and skill queues as read-only, so neither can be modified through this MCP. Multi-character support is built in.

## Development

```bash
npm run dev          # Run with tsx (no build needed)
npm test             # Run test suite
npm run test:watch   # Watch mode
npm run build        # Compile TypeScript
```

## Data

- **SDE**: `~/.eve-sde/eve.db` — use `refresh_sde` to update
- **Auth tokens**: `~/.eve-sde/auth.db` — encrypted, use `esi_logout` to remove
- **Config**: `~/.eve-sde/config.json` — EVE SSO Client ID
- The `query_sde` tool allows arbitrary SELECT queries for anything the specific tools don't cover

## License

MIT
