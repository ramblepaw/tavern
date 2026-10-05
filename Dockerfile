FROM node:24-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app

# Dependencies first so rebuilds are fast when only app code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY scripts ./scripts
COPY public ./public

# Make sure the PNG icons iOS needs exist, so the app never has to write into /app at runtime.
RUN node -e "import('./server/icons.js').then((m) => m.ensureIcons())"

# Database, uploads and push keys live here. Mount a volume on it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Runs as an unprivileged user. On TrueNAS the compose file overrides this with the "apps" user (568).
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
