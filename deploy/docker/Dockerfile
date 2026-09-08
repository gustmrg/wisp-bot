FROM node:24.18.0-bookworm-slim AS build
WORKDIR /source
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:server && npm run build:web

FROM node:24.18.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/wisp
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /source/dist-server/ ./
COPY --from=build /source/dist-web/ ./web/
COPY deploy/wispctl /usr/local/bin/wispctl
RUN chmod 755 /usr/local/bin/wispctl && mkdir /data && chown node:node /data
ENV NODE_ENV=production WISP_INSTALL_DIR=/opt/wisp WISP_DATA_DIR=/data WISP_HOST=0.0.0.0 WISP_ALLOW_EXTERNAL_BIND=1 WISP_WEB_ROOT=/opt/wisp/web
USER node
EXPOSE 8787
CMD ["node", "server/main.js"]
