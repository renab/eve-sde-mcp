import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { subscriptionShape,subscribeDataset,removeSubscription,listSubscriptions,listDatasetTypes } from "../keep-warm.js";
import { jsonResult } from "../utils.js";
export function registerKeepWarmTools(server:McpServer):void {
  server.tool("keep_warm_dataset","Explicitly enroll/update a supported logical dataset. No immediate ESI call or arbitrary URLs. Freshness/backoff remain authoritative. Re-enabling resets blocked status. Seed an uncached dataset with its normal foreground read first.",subscriptionShape,async args=>jsonResult(subscribeDataset(args)));
  server.tool("remove_keep_warm_dataset","Remove a subscription by id. Does not delete ESI cache data; an already-in-flight request may finish.",{id:z.string().min(1)},async({id})=>jsonResult(removeSubscription(id)));
  server.tool("list_keep_warm_datasets","List subscriptions and locally inspected cache eligibility/auth/error status. Makes no ESI or SSO calls.",{limit:z.number().int().min(1).max(200).default(100),offset:z.number().int().min(0).default(0)},async({limit,offset})=>jsonResult(listSubscriptions(limit,offset)));
  server.tool("list_keep_warm_dataset_types","Discover internally registered dataset types, required scopes and parameter schemas. Support does not imply enrollment.",{},async()=>jsonResult({datasets:listDatasetTypes()}));
}
