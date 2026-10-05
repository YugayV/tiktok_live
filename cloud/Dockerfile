# Build from the tiklive/ directory:  docker build -f cloud/Dockerfile -t tiklive-cloud .
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/ai.mjs src/ai.mjs
COPY cloud/ cloud/
ENV PORT=8080 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "cloud/server.mjs"]
