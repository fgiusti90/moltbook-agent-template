FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy TypeScript config and source
COPY tsconfig.json ./
COPY src/ ./src/

# Install dev deps temporarily for build, then remove
RUN npm install typescript --save-dev && \
    npx tsc && \
    npm prune --omit=dev && \
    rm -rf src/ tsconfig.json

# Create logs directory
RUN mkdir -p logs

# Non-root user for security
RUN addgroup -g 1001 agent && \
    adduser -u 1001 -G agent -s /bin/sh -D agent && \
    chown -R agent:agent /app

USER agent

CMD ["node", "dist/index.js"]
