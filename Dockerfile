FROM node:20-slim
WORKDIR /app

# better-sqlite3 may need native compile if prebuild is unavailable
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && test -f node_modules/fastify/package.json \
  && test -f node_modules/better-sqlite3/package.json

# Prebuilt by deploy script (tsc + vite)
COPY dist/ ./dist/
COPY web/dist/ ./web/dist/

EXPOSE 3220
ENV PORT=3220
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
CMD ["node", "dist/server.js"]
