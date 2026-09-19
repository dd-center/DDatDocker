FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Runtime contains Node + ws only; npm, yarn and build tools stay out.
FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
RUN apk add --no-cache libstdc++ ca-certificates \
    && addgroup -g 1000 node && adduser -D -u 1000 -G node node \
    && mkdir /data && chown node:node /data
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY licenses/node-LICENSE /usr/local/share/licenses/node/LICENSE
WORKDIR /app
ENV NODE_ENV=production DOCKER=true DATA_DIR=/data
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json index.js healthcheck.js healthcheck.sh docker-entrypoint.sh LICENSE ./
COPY --chown=node:node lib ./lib
USER node
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["sh", "/app/healthcheck.sh"]
CMD ["sh", "/app/docker-entrypoint.sh"]
