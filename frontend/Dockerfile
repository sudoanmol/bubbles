FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ARG VITE_BACKEND_URL
ARG VITE_WS_URL
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL \
    VITE_WS_URL=$VITE_WS_URL
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.ts ./server.ts
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
