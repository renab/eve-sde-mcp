# Corporation ESI coverage

Verified against [CCP OpenAPI](https://esi.evetech.net/meta/openapi.json) on 2026-09-12. All 39 corporation-specific GET routes and the two existing asset lookup POST routes are exposed. ESI has no outstanding corporate bills endpoint. Wallet journals record past payments, not outstanding obligations; character notifications may contain bill alerts but are not a complete bill ledger.

Select a CEO/director using character_id (or the active character); corporation_id defaults to that character's corporation. Each private read requires its OAuth scope and ESI-enforced corporation access. Run esi_login again after deployment to approve the added scopes; refreshing an old token cannot grant scopes. Public corporation information, icons and alliance history can be read without login when corporation_id is supplied. No corporation writes are exposed.

| Tool | ESI route | Scopes |
| --- | --- | --- |
| get_corporation_mining_extractions | `/corporation/{corporation_id}/mining/extractions` | esi-industry.read_corporation_mining.v1 |
| get_corporation_mining_observers | `/corporation/{corporation_id}/mining/observers` | esi-industry.read_corporation_mining.v1 |
| get_corporation_mining_observer | `/corporation/{corporation_id}/mining/observers/{observer_id}` | esi-industry.read_corporation_mining.v1 |
| get_corporation_info | `/corporations/{corporation_id}` | Public |
| get_corporation_alliance_history | `/corporations/{corporation_id}/alliancehistory` | Public |
| get_corporation_assets | `/corporations/{corporation_id}/assets` | esi-assets.read_corporation_assets.v1 |
| get_corporation_blueprints | `/corporations/{corporation_id}/blueprints` | esi-corporations.read_blueprints.v1 |
| get_corporation_contacts | `/corporations/{corporation_id}/contacts` | esi-corporations.read_contacts.v1 |
| get_corporation_contacts_labels | `/corporations/{corporation_id}/contacts/labels` | esi-corporations.read_contacts.v1 |
| get_corporation_container_logs | `/corporations/{corporation_id}/containers/logs` | esi-corporations.read_container_logs.v1 |
| get_corporation_contracts | `/corporations/{corporation_id}/contracts` | esi-contracts.read_corporation_contracts.v1 |
| get_corporation_contract_bids | `/corporations/{corporation_id}/contracts/{contract_id}/bids` | esi-contracts.read_corporation_contracts.v1 |
| get_corporation_contract_items | `/corporations/{corporation_id}/contracts/{contract_id}/items` | esi-contracts.read_corporation_contracts.v1 |
| get_corporation_customs_offices | `/corporations/{corporation_id}/customs_offices` | esi-planets.read_customs_offices.v1 |
| get_corporation_divisions | `/corporations/{corporation_id}/divisions` | esi-corporations.read_divisions.v1 |
| get_corporation_facilities | `/corporations/{corporation_id}/facilities` | esi-corporations.read_facilities.v1 |
| get_corporation_fw_stats | `/corporations/{corporation_id}/fw/stats` | esi-corporations.read_fw_stats.v1 |
| get_corporation_icons | `/corporations/{corporation_id}/icons` | Public |
| get_corporation_industry_jobs | `/corporations/{corporation_id}/industry/jobs` | esi-industry.read_corporation_jobs.v1 |
| get_corporation_recent_killmails | `/corporations/{corporation_id}/killmails/recent` | esi-killmails.read_corporation_killmails.v1 |
| get_corporation_medals | `/corporations/{corporation_id}/medals` | esi-corporations.read_medals.v1 |
| get_corporation_medals_issued | `/corporations/{corporation_id}/medals/issued` | esi-corporations.read_medals.v1 |
| get_corporation_members | `/corporations/{corporation_id}/members` | esi-corporations.read_corporation_membership.v1 |
| get_corporation_members_limit | `/corporations/{corporation_id}/members/limit` | esi-corporations.track_members.v1 |
| get_corporation_members_titles | `/corporations/{corporation_id}/members/titles` | esi-corporations.read_titles.v1 |
| get_corporation_member_tracking | `/corporations/{corporation_id}/membertracking` | esi-corporations.track_members.v1 |
| get_corporation_orders | `/corporations/{corporation_id}/orders` | esi-markets.read_corporation_orders.v1 |
| get_corporation_orders_history | `/corporations/{corporation_id}/orders/history` | esi-markets.read_corporation_orders.v1 |
| get_corporation_roles | `/corporations/{corporation_id}/roles` | esi-corporations.read_corporation_membership.v1 |
| get_corporation_roles_history | `/corporations/{corporation_id}/roles/history` | esi-corporations.read_corporation_membership.v1 |
| get_corporation_shareholders | `/corporations/{corporation_id}/shareholders` | esi-wallet.read_corporation_wallets.v1 |
| get_corporation_standings | `/corporations/{corporation_id}/standings` | esi-corporations.read_standings.v1 |
| get_corporation_starbases | `/corporations/{corporation_id}/starbases` | esi-corporations.read_starbases.v1 |
| get_corporation_starbase | `/corporations/{corporation_id}/starbases/{starbase_id}` | esi-corporations.read_starbases.v1 |
| get_corporation_structures | `/corporations/{corporation_id}/structures` | esi-corporations.read_structures.v1 |
| get_corporation_titles | `/corporations/{corporation_id}/titles` | esi-corporations.read_titles.v1 |
| get_corporation_wallets | `/corporations/{corporation_id}/wallets` | esi-wallet.read_corporation_wallets.v1 |
| get_corporation_wallet_journal | `/corporations/{corporation_id}/wallets/{division}/journal` | esi-wallet.read_corporation_wallets.v1 |
| get_corporation_wallet_transactions | `/corporations/{corporation_id}/wallets/{division}/transactions` | esi-wallet.read_corporation_wallets.v1 |

Existing `get_corporation_asset_names` and `get_corporation_asset_locations` cover the two read-only POST routes. List tools use limit/offset; paginated ESI routes fetch all pages before slicing. Object and scalar endpoints preserve their native shape. Starbase detail requires system_id.


`get_corporation_wallet_transactions` accepts `from_id` to request transactions older than a given transaction ID; this ESI route uses a cursor rather than page numbers.
