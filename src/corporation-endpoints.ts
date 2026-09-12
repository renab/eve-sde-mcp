// Verified against https://esi.evetech.net/meta/openapi.json on 2026-09-12.
export const corporationEndpoints = [
  {
    "name": "get_corporation_mining_extractions",
    "path": "/corporation/{corporation_id}/mining/extractions",
    "description": "Extraction timers for all moon chunks being extracted by refineries belonging to a corporation.",
    "scopes": [
      "esi-industry.read_corporation_mining.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_mining_observers",
    "path": "/corporation/{corporation_id}/mining/observers",
    "description": "Paginated list of all entities capable of observing and recording mining for a corporation",
    "scopes": [
      "esi-industry.read_corporation_mining.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_mining_observer",
    "path": "/corporation/{corporation_id}/mining/observers/{observer_id}",
    "description": "Paginated record of all mining seen by an observer",
    "scopes": [
      "esi-industry.read_corporation_mining.v1"
    ],
    "paginated": true,
    "parameters": [
      {
        "name": "observer_id",
        "location": "path",
        "required": true
      }
    ],
    "existing": false
  },
  {
    "name": "get_corporation_info",
    "path": "/corporations/{corporation_id}",
    "description": "Public information about a corporation",
    "scopes": [],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_alliance_history",
    "path": "/corporations/{corporation_id}/alliancehistory",
    "description": "Get a list of all the alliances a corporation has been a member of",
    "scopes": [],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_assets",
    "path": "/corporations/{corporation_id}/assets",
    "description": "Return a list of the corporation assets",
    "scopes": [
      "esi-assets.read_corporation_assets.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": true
  },
  {
    "name": "get_corporation_blueprints",
    "path": "/corporations/{corporation_id}/blueprints",
    "description": "Returns a list of blueprints the corporation owns",
    "scopes": [
      "esi-corporations.read_blueprints.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": true
  },
  {
    "name": "get_corporation_contacts",
    "path": "/corporations/{corporation_id}/contacts",
    "description": "Return contacts of a corporation",
    "scopes": [
      "esi-corporations.read_contacts.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_contacts_labels",
    "path": "/corporations/{corporation_id}/contacts/labels",
    "description": "Return custom labels for a corporation's contacts",
    "scopes": [
      "esi-corporations.read_contacts.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_container_logs",
    "path": "/corporations/{corporation_id}/containers/logs",
    "description": "Returns logs recorded in the past seven days from all audit log secure containers (ALSC) owned by a given corporation",
    "scopes": [
      "esi-corporations.read_container_logs.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_contracts",
    "path": "/corporations/{corporation_id}/contracts",
    "description": "Returns contracts available to a corporation, only if the corporation is issuer, acceptor or assignee. Only returns contracts no older than 30 days, or if the status is \"in_progress\".",
    "scopes": [
      "esi-contracts.read_corporation_contracts.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_contract_bids",
    "path": "/corporations/{corporation_id}/contracts/{contract_id}/bids",
    "description": "Lists bids on a particular auction contract",
    "scopes": [
      "esi-contracts.read_corporation_contracts.v1"
    ],
    "paginated": true,
    "parameters": [
      {
        "name": "contract_id",
        "location": "path",
        "required": true
      }
    ],
    "existing": false
  },
  {
    "name": "get_corporation_contract_items",
    "path": "/corporations/{corporation_id}/contracts/{contract_id}/items",
    "description": "Lists items of a particular contract",
    "scopes": [
      "esi-contracts.read_corporation_contracts.v1"
    ],
    "paginated": false,
    "parameters": [
      {
        "name": "contract_id",
        "location": "path",
        "required": true
      }
    ],
    "existing": false
  },
  {
    "name": "get_corporation_customs_offices",
    "path": "/corporations/{corporation_id}/customs_offices",
    "description": "List customs offices owned by a corporation",
    "scopes": [
      "esi-planets.read_customs_offices.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_divisions",
    "path": "/corporations/{corporation_id}/divisions",
    "description": "Return corporation hangar and wallet division names, only show if a division is not using the default name",
    "scopes": [
      "esi-corporations.read_divisions.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_facilities",
    "path": "/corporations/{corporation_id}/facilities",
    "description": "Return a corporation's facilities",
    "scopes": [
      "esi-corporations.read_facilities.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_fw_stats",
    "path": "/corporations/{corporation_id}/fw/stats",
    "description": "Statistics about a corporation involved in faction warfare\n\nThis route expires daily at 11:05",
    "scopes": [
      "esi-corporations.read_fw_stats.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_icons",
    "path": "/corporations/{corporation_id}/icons",
    "description": "Get the icon urls for a corporation",
    "scopes": [],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_industry_jobs",
    "path": "/corporations/{corporation_id}/industry/jobs",
    "description": "List industry jobs run by a corporation",
    "scopes": [
      "esi-industry.read_corporation_jobs.v1"
    ],
    "paginated": true,
    "parameters": [
      {
        "name": "include_completed",
        "location": "query",
        "required": false
      }
    ],
    "existing": true
  },
  {
    "name": "get_corporation_recent_killmails",
    "path": "/corporations/{corporation_id}/killmails/recent",
    "description": "Get a list of a corporation's kills and losses going back 90 days",
    "scopes": [
      "esi-killmails.read_corporation_killmails.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_medals",
    "path": "/corporations/{corporation_id}/medals",
    "description": "Returns a corporation's medals",
    "scopes": [
      "esi-corporations.read_medals.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_medals_issued",
    "path": "/corporations/{corporation_id}/medals/issued",
    "description": "Returns medals issued by a corporation",
    "scopes": [
      "esi-corporations.read_medals.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_members",
    "path": "/corporations/{corporation_id}/members",
    "description": "Return the current member list of a corporation, the token's character need to be a member of the corporation.",
    "scopes": [
      "esi-corporations.read_corporation_membership.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_members_limit",
    "path": "/corporations/{corporation_id}/members/limit",
    "description": "Return a corporation's member limit, not including CEO himself",
    "scopes": [
      "esi-corporations.track_members.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_members_titles",
    "path": "/corporations/{corporation_id}/members/titles",
    "description": "Returns a corporation's members' titles",
    "scopes": [
      "esi-corporations.read_titles.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_member_tracking",
    "path": "/corporations/{corporation_id}/membertracking",
    "description": "Returns additional information about a corporation's members which helps tracking their activities",
    "scopes": [
      "esi-corporations.track_members.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_orders",
    "path": "/corporations/{corporation_id}/orders",
    "description": "List open market orders placed on behalf of a corporation",
    "scopes": [
      "esi-markets.read_corporation_orders.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_orders_history",
    "path": "/corporations/{corporation_id}/orders/history",
    "description": "List cancelled and expired market orders placed on behalf of a corporation up to 90 days in the past.",
    "scopes": [
      "esi-markets.read_corporation_orders.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_roles",
    "path": "/corporations/{corporation_id}/roles",
    "description": "Return the roles of all members if the character has the personnel manager role or any grantable role.",
    "scopes": [
      "esi-corporations.read_corporation_membership.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_roles_history",
    "path": "/corporations/{corporation_id}/roles/history",
    "description": "Return how roles have changed for a coporation's members, up to a month",
    "scopes": [
      "esi-corporations.read_corporation_membership.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_shareholders",
    "path": "/corporations/{corporation_id}/shareholders",
    "description": "Return the current shareholders of a corporation.",
    "scopes": [
      "esi-wallet.read_corporation_wallets.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_standings",
    "path": "/corporations/{corporation_id}/standings",
    "description": "Return corporation standings from agents, NPC corporations, and factions",
    "scopes": [
      "esi-corporations.read_standings.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_starbases",
    "path": "/corporations/{corporation_id}/starbases",
    "description": "Returns list of corporation starbases (POSes)",
    "scopes": [
      "esi-corporations.read_starbases.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_starbase",
    "path": "/corporations/{corporation_id}/starbases/{starbase_id}",
    "description": "Returns various settings and fuels of a starbase (POS)",
    "scopes": [
      "esi-corporations.read_starbases.v1"
    ],
    "paginated": false,
    "parameters": [
      {
        "name": "starbase_id",
        "location": "path",
        "required": true
      },
      {
        "name": "system_id",
        "location": "query",
        "required": true
      }
    ],
    "existing": false
  },
  {
    "name": "get_corporation_structures",
    "path": "/corporations/{corporation_id}/structures",
    "description": "Get a list of corporation structures. This route's version includes the changes to structures detailed in this blog: https://www.eveonline.com/article/upwell-2.0-structures-changes-coming-on-february-13th",
    "scopes": [
      "esi-corporations.read_structures.v1"
    ],
    "paginated": true,
    "parameters": [],
    "existing": true
  },
  {
    "name": "get_corporation_titles",
    "path": "/corporations/{corporation_id}/titles",
    "description": "Returns a corporation's titles",
    "scopes": [
      "esi-corporations.read_titles.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": false
  },
  {
    "name": "get_corporation_wallets",
    "path": "/corporations/{corporation_id}/wallets",
    "description": "Get a corporation's wallets",
    "scopes": [
      "esi-wallet.read_corporation_wallets.v1"
    ],
    "paginated": false,
    "parameters": [],
    "existing": true
  },
  {
    "name": "get_corporation_wallet_journal",
    "path": "/corporations/{corporation_id}/wallets/{division}/journal",
    "description": "Retrieve the given corporation's wallet journal for the given division going 30 days back",
    "scopes": [
      "esi-wallet.read_corporation_wallets.v1"
    ],
    "paginated": true,
    "parameters": [
      {
        "name": "division",
        "location": "path",
        "required": true
      }
    ],
    "existing": true
  },
  {
    "name": "get_corporation_wallet_transactions",
    "path": "/corporations/{corporation_id}/wallets/{division}/transactions",
    "description": "Get wallet transactions of a corporation",
    "scopes": [
      "esi-wallet.read_corporation_wallets.v1"
    ],
    "paginated": false,
    "parameters": [
      {
        "name": "division",
        "location": "path",
        "required": true
      },
      {
        "name": "from_id",
        "location": "query",
        "required": false
      }
    ],
    "existing": true
  }
] as const;
export const CORPORATION_SCOPES = [...new Set(corporationEndpoints.flatMap(endpoint => [...endpoint.scopes]))];

