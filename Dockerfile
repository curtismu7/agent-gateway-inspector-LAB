# Two stages: the first builds the web UI, the final image carries the server and the built UI only.
# Node 26 only (rulebook). Docker on OrbStack, never Docker Desktop.
# No host tools in the image: nothing here can read the host, and the gateway forwards to in-process stubs only.
FROM node:26-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts -w web --include-workspace-root=false && npm cache clean --force
COPY web web
RUN npm run build -w web

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=5850
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server --ignore-scripts && npm cache clean --force
COPY server/src server/src
COPY server/diagrams server/diagrams
COPY --from=web /app/web/dist web/dist
USER node
EXPOSE 5850
# Inside the container the server must listen on all interfaces, so GATEWAY_INSPECTOR_BIND is set here on purpose.
# The compose file publishes the port on 127.0.0.1 only; do not publish it more widely.
ENV GATEWAY_INSPECTOR_BIND=0.0.0.0
CMD ["node", "server/src/index.js"]
