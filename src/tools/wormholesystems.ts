import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWormholeSystems, type WormholeSystemsService } from "../wormholesystems.js";

const id = z.string().min(1).max(512);
const secret = z.string().min(1).max(4096).describe("WormholeSystems bearer credential. Stored encrypted; never echo or log it.");

export function registerWormholeSystemsTools(server: McpServer, getService: () => WormholeSystemsService = getWormholeSystems): void {
  const tool = (name: string, description: string, schema: Record<string, z.ZodType>, fn: (service: WormholeSystemsService, args: any) => unknown) => {
    server.tool(name, description, schema, async (args: any) => {
      try { return { content: [{ type: "text" as const, text: JSON.stringify(await fn(getService(), args)) }] }; }
      catch { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: "WormholeSystems operation failed; check configuration and status. Credential values are never returned." }) }] }; }
    });
  };

  tool("wormholesystems_add_credential", "Encrypt and store a WormholeSystems bearer credential. This does not contact the source or enable sync.",
    { api_token: secret, label: z.string().max(160).optional() }, (service, args) => service.addCredential(args));
  tool("wormholesystems_list_credentials", "List safe WormholeSystems credential metadata. Never returns credentials.", {}, service => service.listCredentials());
  tool("wormholesystems_update_credential", "Update safe credential label or replace the encrypted credential. Replacement is not validated against a live service.",
    { credential_id: id, api_token: secret.optional(), label: z.string().max(160).optional() }, (service, args) => service.updateCredential(args.credential_id, args));
  tool("wormholesystems_remove_credential", "Remove Galaxy's encrypted copy of a WormholeSystems credential; this does not revoke it upstream.",
    { credential_id: id }, (service, args) => service.removeCredential(args.credential_id));
  tool("wormholesystems_configure", "Configure an exact HTTPS origin, verified API path prefix, explicit canonical Nexum map ID, upstream API map ID, route-key mode and stored credential. Configuration never enables sync.",
    { origin: z.string().min(1).max(512), api_path_prefix: z.string().min(1).max(256), map_route_key: z.enum(["id", "slug"]),
      canonical_map_id: id, upstream_map_id: id, credential_id: id }, (service, args) => service.configure(args));
  tool("wormholesystems_get_config", "Read safe WormholeSystems source configuration and activation blockers. Never returns credentials or makes network calls.",
    {}, service => service.configuration());
  tool("wormholesystems_set_max_staleness", "Set the persisted global WormholeSystems and Nexum matching freshness bound in milliseconds. Requires a configured source; performs no network calls or writes.",
    { max_staleness_ms: z.number().finite() }, (service, args) => service.setMaxStaleness(args.max_staleness_ms));
  tool("wormholesystems_remove_config", "Remove the current WormholeSystems source configuration and reset freshness policy to the approved 60,000 ms default. This does not remove the encrypted credential or source snapshots.",
    {}, service => service.removeConfiguration());
  tool("wormholesystems_test_connection", "Explicitly test bearer access by listing accessible maps and requesting the explicitly selected map detail. This does not enable sync.",
    {}, service => service.testConnection());
  tool("wormholesystems_enable_sync", "Explicitly enable on-demand, GET-only source snapshot synchronization after a successful connection and selected-map schema test. Never enables Nexum writes.",
    {}, service => service.enableSync());
  tool("wormholesystems_disable_sync", "Disable on-demand WormholeSystems source synchronization. This never changes Nexum data.",
    {}, service => service.disableSync());
  tool("wormholesystems_list_maps", "List accessible WormholeSystems API map IDs and slugs using the configured origin and credential. Explicit upstream GET; no sync or writes.",
    {}, service => service.listAccessibleMaps());
  tool("wormholesystems_sync_map", "Fetch and validate one explicitly enabled map snapshot. Eligible source-owned topology and signature notes may be applied to Nexum after final serialized revalidation; names and custom labels remain disabled.",
    { map_id: id }, (service, args) => service.syncMap(args.map_id));
  tool("wormholesystems_map_sync_status", "Read local source snapshot/run status and a local-only preview summary. No upstream calls or Nexum writes.",
    { map_id: id }, (service, args) => service.status(args.map_id));
  tool("wormholesystems_preview_map_sync", "Local-only preview diagnostics. Makes zero upstream requests and reports independent topology and alliance-note eligibility; does not write.",
    { map_id: id }, (service, args) => service.preview(args.map_id));
}
