FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY package.json ./
COPY src ./src
COPY public ./public
# Runs as root by default so a root-owned appdata folder (Unraid default) just works.
# To run unprivileged, start the container with --user 99:100 and chown the data folder to match.
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/state >/dev/null || exit 1
CMD ["node", "src/server.js"]
