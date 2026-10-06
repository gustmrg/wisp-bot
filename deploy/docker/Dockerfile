# Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t wisp-server .
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Only the TypeScript toolchain is needed here; skip Electron's binary download.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run package:server

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    WISP_DATA_DIR=/data \
    WISP_HOST=0.0.0.0 \
    WISP_ALLOW_EXTERNAL_BIND=1 \
    WISP_PORT=8787
WORKDIR /opt/wisp
COPY --from=build /src/release/server ./
RUN npm install --omit=dev && npm cache clean --force \
    && chmod 755 server/cli.js && ln -s /opt/wisp/server/cli.js /usr/local/bin/wispctl \
    && mkdir -m 700 /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/main.js"]
