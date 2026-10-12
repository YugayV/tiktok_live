# Build from the repository root:  docker build -f hosted/Dockerfile -t tiklive-web .
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/ src/
COPY public/ public/
COPY hosted/ hosted/
ENV PORT=8080 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
USER node
CMD ["node", "hosted/main.mjs"]
