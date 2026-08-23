FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && cp -r node_modules prod_node_modules
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache dumb-init wget
ENV NODE_ENV=production PORT=8080 DB_PATH=/app/data/duekeeper.db
RUN mkdir -p /app/data && chown -R node:node /app
USER node
COPY --from=build /app/prod_node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8080/api/health/liveness || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
