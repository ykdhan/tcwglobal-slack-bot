# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

# tsc emits JavaScript only. The form schemas are data files that sit beside
# their form definitions and have to be carried over separately — as a directory
# sweep, so that adding a form does not mean editing this line. A hardcoded
# single-file copy would build cleanly and fail at runtime.
RUN pnpm build && \
    cd src && find . -name '*.json' -exec cp --parents {} ../dist/ \;


FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

COPY --from=build /app/dist ./dist

# The encrypted profile store lives here, on a mounted volume in production.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

# No EXPOSE: Socket Mode opens an outbound WebSocket and the app never listens
# on a port. A health check pointed at this container will fail forever.
CMD ["node", "dist/app.js"]
