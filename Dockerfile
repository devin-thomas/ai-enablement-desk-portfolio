FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json

RUN npm ci --omit=dev --workspace @ai-enablement/server --include-workspace-root=false

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DEMO_MODE=false \
    HOST=0.0.0.0 \
    PORT=3001

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node apps/server/package.json apps/server/package.json
COPY --chown=node:node apps/server/src apps/server/src
COPY --chown=node:node packages/contracts packages/contracts
COPY --chown=node:node packages/domain packages/domain
COPY --chown=node:node database/migrations database/migrations
COPY --chown=node:node fixtures/requests fixtures/requests

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM

CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
