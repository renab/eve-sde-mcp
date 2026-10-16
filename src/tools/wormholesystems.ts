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
  tool("wormholesystems_bind_nexum_topology_writer", "Explicitly bind one enabled map-accessible Nexum key to the configured canonical map. Calling this confirms the operator has verified wormholesystems_sync scope and deployment of the v2 endpoint; this tool makes no Nexum request.",
    { credential_id: id, confirm_v2_endpoint_deployed: z.literal(true) },
    (service, args) => service.bindNexumTopologyWriter(args.credential_id, args.confirm_v2_endpoint_deployed));
  tool("wormholesystems_set_max_staleness", "Set the persisted global WormholeSystems and Nexum matching freshness bound in milliseconds. Requires a configured source; performs no network calls or writes.",
    { max_staleness_ms: z.number().finite() }, (service, args) => service.setMaxStaleness(args.max_staleness_ms));
  tool("wormholesystems_remove_config", "Remove the current WormholeSystems source configuration and reset freshness policy to the approved 60,000 ms default. This does not remove the encrypted credential or source snapshots.",
    {}, service => service.removeConfiguration());
  tool("wormholesystems_test_connection", "Explicitly test bearer access by listing accessible maps and requesting the explicitly selected map detail. This does not enable sync.",
    {}, service => service.testConnection());
  tool("wormholesystems_enable_sync", "Explicitly enable on-demand source snapshot synchronization after a successful connection and selected-map schema test. Data writes still require the separately bound Nexum schema-v2 writer and a fresh complete source-v3 snapshot.",
    {}, service => service.enableSync());
  tool("wormholesystems_disable_sync", "Disable on-demand WormholeSystems source synchronization. This never changes Nexum data.",
    {}, service => service.disableSync());
  tool("wormholesystems_list_maps", "List accessible WormholeSystems API map IDs and slugs using the configured origin and credential. Explicit upstream GET; no sync or writes.",
    {}, service => service.listAccessibleMaps());
  tool("wormholesystems_sync_map", "Fetch and validate a fresh complete v3 selected alliance-map snapshot, store its provenance, then reconcile it using the Nexum schema-v2 topology/signature request to its explicitly bound Nexum map in this same invocation. Blocked projections send no partial PUT. Never writes linked notes. Preview remains local-only and is not an approval step.",
    { map_id: id }, (service, args) => service.syncMap(args.map_id));
  tool("wormholesystems_map_sync_status", "Read local source snapshot/run status and a local-only preview summary. No upstream calls or Nexum writes.",
    { map_id: id }, (service, args) => service.status(args.map_id));
  tool("wormholesystems_preview_map_sync", "Local-only preview of the stored source snapshot, freshness/blockers, and bounded allowlisted full-detail signature classification fields including category labels. Makes zero upstream requests and performs no Nexum writes; legacy v1/v2 snapshots report category names as not_captured_in_snapshot and are read-only.",
    { map_id: id }, (service, args) => service.preview(args.map_id));
  tool("wormholesystems_reconcile_linked_notes", "Deliberately PATCH eligible linked-direction alliance notes on the configured canonical map only. Requires a fresh validated source snapshot and exact fresh Nexum linked-signature matches; skips non-empty manual/unknown notes. Does not write topology or signatures, and never acts on unconnected signatures.",
    { map_id: id }, (service, args) => service.reconcileLinkedNotes(args.map_id));
}
