# Build from the substream/ directory:
#   docker build -f services/keeper/Dockerfile -t substream-keeper .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY services/keeper/package.json services/keeper/
RUN npm ci

FROM deps AS build
COPY packages/sdk packages/sdk
COPY services/keeper services/keeper
RUN npm run build -w @substream/sdk

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /app/services/keeper/package.json ./services/keeper/package.json
COPY --from=build /app/services/keeper/src ./services/keeper/src
USER node
EXPOSE 8788
CMD ["npm", "run", "start", "-w", "@substream/keeper"]
