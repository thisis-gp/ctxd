# Multi-stage build for hosted ctxd (HTTP MCP).
FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY semantics ./semantics
COPY context.contract.json ./
RUN yarn build && yarn install --production --frozen-lockfile

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/semantics ./semantics
COPY --from=build /app/context.contract.json ./
COPY .env.example ./
RUN mkdir -p /data/snapshots
ENV SNAPSHOT_DIR=/data/snapshots
EXPOSE 8787
# Serve remote MCP; Metabase credentials come from env. Run `refresh` separately (cron/compose profile).
CMD ["node", "dist/cli.js", "serve", "--http"]
