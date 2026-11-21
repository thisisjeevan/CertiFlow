FROM node:24-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS tools
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY apps/api apps/api
COPY docker/start-backend.sh /usr/local/bin/start-backend
RUN chmod +x /usr/local/bin/start-backend \
    && npm run db:generate \
    && npm run build -w @certiflow/api
ENTRYPOINT ["start-backend"]

FROM tools AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=tools /app/apps/api/package.json ./apps/api/package.json
COPY --from=tools /app/apps/api/dist ./apps/api/dist
COPY --from=tools /usr/local/bin/start-backend /usr/local/bin/start-backend
RUN install -d -o node -g node -m 0700 /var/lib/certiflow/certificates
USER node
ENTRYPOINT ["start-backend"]
CMD ["node", "apps/api/dist/server.js"]
