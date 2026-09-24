# Galaxy (eve-sde-mcp) container image.
#
# Multi-stage build on node:20-alpine (Node version pinned by .nvmrc).
# better-sqlite3 is a native module without prebuilt binaries for Node 20,
# so the C/C++ toolchain exists only in the build stage. The runtime image
# contains no build tools, no secrets, and no data: all runtime state lives
# under /home/node/.eve-sde and is expected to come from a mounted volume.
# See docs/container-deployment.md.

FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001
# Runtime state directory (SDE, auth tokens, ledger). Mount a volume here.
RUN mkdir -p /home/node/.eve-sde && chown node:node /home/node/.eve-sde
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=900s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/http.js"]
