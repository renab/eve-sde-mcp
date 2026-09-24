# Container deployment (GHCR → k3s)

Galaxy is built as a container image by GitHub Actions and published to the
public GHCR package `ghcr.io/renab/galaxy` (the repository is public and
anyone can pull the image without authentication). Kubernetes deployment
configuration is owned by the `homelab-infra` repository and Argo CD; this
repository never deploys to the cluster and does not contain cluster manifests.

Flow: public Galaxy source → GitHub-hosted Actions → public GHCR image →
Argo-managed k3s StatefulSet pulling the image anonymously.

## Image

- Base: `node:20-alpine` (Node pinned by `.nvmrc`). Multi-stage build:
  - build stage: `npm ci` (compiles the better-sqlite3 native module with the
    C/C++ toolchain — no prebuilt binaries exist for Node 20), `npm run build`
    (`tsc`), then `npm prune --omit=dev`;
  - runtime stage: production `node_modules`, compiled `dist/`, and
    `package.json` only. No build tools, no source, no secrets, no data.
- Runs as the unprivileged `node` user (uid 1000) and listens on all
  interfaces (`HOST=0.0.0.0` default).
- Startup command (image `CMD`): `node dist/http.js` — the stateless HTTP
  bridge, the same entry point used by the PM2 production deployment.
  `SIGTERM` triggers a graceful shutdown.

## Building and publishing

- `.github/workflows/container.yml` runs on `ubuntu-latest`:
  - `pull_request` and `push` to `main`: `npm ci`, `npm run build` (type
    check), SDE database download (the test suite queries a real
    `~/.eve-sde/eve.db`, the same first-run behavior the app itself performs),
    then `npm test`.
  - `push` to `main` only: builds and pushes the image after tests pass.
- Authentication to GHCR uses the built-in `GITHUB_TOKEN` (no custom secret).
  Workflow permissions are minimal: `contents: read`, `packages: write`.
  The token is only passed to the login action input and never echoed.

### Public image (safe by construction)

- The repository and the `galaxy` GHCR package are **public**:
  `docker pull ghcr.io/renab/galaxy:<tag>` works without authentication
  (verified against the published `main` tag).
- That is acceptable because the image contains no secrets and no data. The
  published image's full filesystem was audited after a pull: base
  `node:20-alpine`, compiled `dist/`, production `node_modules`,
  `package.json`, and an empty `/home/node/.eve-sde`. No `.env` files, keys,
  tokens, databases, git metadata, or local build paths in source maps.
- All sensitive state (SDE `eve.db`, `auth.db`, `config.json`,
  `galaxy-state.db`, `galaxy-secret.key`) lives on the mounted state volume
  (see below), never in the image.
- Keep it that way. The build context is the whole repository, and only the
  paths the Dockerfile copies end up in the image (currently `package.json`,
  `tsconfig.json`, and `src/`). Adding a secret, credential, or personal data
  to the Dockerfile or to any copied path would expose it publicly. Do not
  bake secrets into the image or pass them as build args/env.
- k3s has no in-cluster registry; it pulls directly from GHCR.

### Image naming and tags

- `ghcr.io/renab/galaxy:<full commit SHA>` — immutable, the **deployment
  identifier**. Argo CD deployments must pin this tag.
- `ghcr.io/renab/galaxy:main` — mutable human-friendly pointer updated on
  every push to `main`. Never use it as the deployment identifier.
- There is no `latest` tag.

## Runtime

### Ports

- `3001` — MCP HTTP bridge (`GET /health`, `POST /mcp`). Override with the
  `PORT` environment variable.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `0.0.0.0` (image) | Bind address |
| `PORT` | `3001` (image) | Listen port |
| `NODE_ENV` | `production` (image) | Runtime mode |
| `GALAXY_STATE_DB` | `/home/node/.eve-sde/galaxy-state.db` | Ledger/ESI cache/Nexum SQLite file |
| `NEXUM_BASE_URL` | `https://eve-nexum.com` | Nexum API base |
| `NEXUM_PRESENCE_RETENTION_HOURS` | `48` | Nexum presence history |
| `NEXUM_STALE_SECONDS` | `300` | Nexum stream staleness |

No secrets are required as environment variables; all credentials are files on
the state volume (below). Do not bake secrets into the image or pass them as
env.

### Persistent storage

One volume mounted at **`/home/node/.eve-sde`** (uid 1000 must own it; in
Kubernetes set `fsGroup: 1000` on the pod):

| File | Content | Notes |
|------|---------|-------|
| `eve.db` | SDE static data (~476 MB) | Replaceable; auto-downloaded from Fuzzwork on first start if missing — the first container start blocks on this download until `/health` responds |
| `metadata.json` | SDE download metadata | Written by the downloader |
| `auth.db` | Encrypted EVE SSO tokens | Sensitive. Encryption key is derived from the pod **hostname** (`src/auth/tokens.ts`), so tokens only decrypt under a stable pod identity — deploy a single-replica StatefulSet (see below); after any hostname change the tokens no longer decrypt and characters must be re-enrolled via `esi_login` |
| `config.json` | EVE SSO `clientId` | Sensitive; create it or enroll via `esi_login` |
| `galaxy-state.db` | Permanent ledger, ESI cache, keep-warm subscriptions, Nexum data | Sensitive; back this up |
| `galaxy-secret.key` | Random key encrypting stored Nexum credentials | Sensitive; lives next to the state DB |

### Secrets

- EVE SSO `clientId` (in `config.json`, or supplied per `esi_login` call).
- Character tokens in `auth.db` (encrypted at rest); `esi_login` requires a
  human to open the returned URL, and the OAuth callback listens on
  `http://localhost:8085` *inside the container* — use `kubectl port-forward`
  for the callback when enrolling, or pre-seed `auth.db`/`config.json` into
  the volume.

### External dependencies (outbound HTTPS)

- `esi.evetech.net` — EVE ESI live data
- `login.eveonline.com` — EVE SSO OAuth
- `www.fuzzwork.co.uk` — SDE download (first start / `refresh_sde`)
- `eve-nexum.com` — Nexum wormhole maps (`NEXUM_BASE_URL`)

### Health and readiness

- `GET /health` → `{"ok":true,"name":"eve-sde","version":"1.0.0"}`,
  unauthenticated. Use it for both liveness and readiness probes.
- There is no separate readiness gate: the process only starts listening after
  the SDE exists (downloading it first if the volume is empty). Give the
  readiness probe a generous `initialDelaySeconds`/start period for first boot
  on an empty volume; subsequent starts are fast.

## What homelab-infra must provide (later)

- A Kubernetes **StatefulSet** (not a Deployment) in `homelab-infra` managed
  by Argo CD, with:
  - image `ghcr.io/renab/galaxy:<full commit SHA>` (pinned per release),
  - `imagePullSecrets` optional while the package is public (below),
  - one volume (e.g. a PVC with a stable name) mounted at `/home/node/.eve-sde`,
  - `securityContext.fsGroup: 1000`,
  - liveness/readiness probes on `GET /health` with a long initial delay,
  - `PORT` (and optionally `GALAXY_STATE_DB`, `NEXUM_*`) via env/config,
  - exactly one replica — do not scale up.
- No in-cluster registry; no GitOps automation in this repository.

### Why a StatefulSet, not a Deployment

The character tokens in `auth.db` are encrypted with a key derived from
`os.hostname()` (see `src/auth/tokens.ts` — platform and arch are constants on
the image, so the hostname is the only variable). A Deployment does not
preserve pod identity: every recreation — node drain, `kubectl rollout`, crash,
eviction — produces a new pod name and therefore a new hostname, which changes
the encryption key and makes every stored character undecryptable until it is
re-enrolled via `esi_login`.

A single-replica StatefulSet keeps the ordinal pod name (`<name>-0`) — and thus
the hostname — stable across recreation, without any change to the Galaxy
application. Keep the StatefulSet's resource name stable for the same reason:
renaming it recreates the pod names and invalidates the tokens. A Deployment
with a pinned `spec.hostname` would also pin the hostname but is not
recommended: with a single `ReadWriteOnce` volume, a rolling update's surge pod
cannot attach the volume while the old pod still runs.

Do not scale beyond one replica: each pod derives a different key (different
hostnames), the `auth.db` and `galaxy-state.db` SQLite files are single-writer,
and the `ReadWriteOnce` volume attaches to one pod only.

### k3s pull (public image)

The package is public, so k3s pulls the image without credentials — no
`imagePullSecrets` is required in the pod spec. If a pull secret is still
preferred (uniformity, or in case the package is ever made private), create
one on the cluster (a long-lived token is required here; the CI
`GITHUB_TOKEN` cannot be used in-cluster):

```bash
kubectl -n <namespace> create secret docker-registry ghcr-galaxy-pull \
  --docker-server=ghcr.io \
  --docker-username=renab \
  --docker-password='<GitHub token with read access to the galaxy package>'
```

The token needs package read access only — a classic PAT with `read:packages`,
or a fine-grained PAT with *Read packages* on `galaxy` — and is referenced
via the pod spec's `imagePullSecrets`.
