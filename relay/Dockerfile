# Two stages, so the image that runs has a compiler in it only by accident of
# history rather than on disk. The result is Node, one dependency, and the relay.

FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist ./dist

# Nothing here writes to disk, reads a config file, or needs a shell, so it runs
# as the image's unprivileged user with no writable state of its own.
USER node

ENV RELAY_HOST=0.0.0.0
ENV RELAY_PORT=8787
EXPOSE 8787

# Checked from inside the container, so it works the same whether the port is
# published, behind a proxy, or on a network the host cannot reach.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Exec form, so SIGTERM reaches the process rather than a shell: shutdown closes
# every session with a reason instead of dropping the sockets.
CMD ["node", "dist/node/index.js"]
