FROM node:20-slim

WORKDIR /app

# Install openssl for HTTPS cert generation
RUN apt-get update && apt-get install -y openssl git && rm -rf /var/lib/apt/lists/*

# Copy server files
COPY server/package*.json ./server/
RUN cd server && npm ci --production

COPY server/ ./server/

# Build TypeScript
RUN cd server && npx tsc

# Expose ports (HTTP + HTTPS)
EXPOSE 3456 3556

# Data + logs persist via volume
VOLUME ["/app/server/data", "/app/server/logs", "/app/server/certs"]

WORKDIR /app/server

CMD ["node", "dist/index.js"]
