# Build from the substream/ directory:
#   docker build -f services/indexer/Dockerfile -t substream-indexer .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY services/indexer/package.json services/indexer/
RUN npm ci

FROM deps AS build
COPY packages/sdk packages/sdk
COPY services/indexer services/indexer
RUN npm run build -w @substream/sdk

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/services/indexer/package.json ./services/indexer/package.json
COPY --from=build /app/services/indexer/src ./services/indexer/src
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["npm", "run", "start", "-w", "@substream/indexer"]
