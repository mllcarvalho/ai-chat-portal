# Relay do portal hospedado — imagem única com a UI dentro (sem S3).
# Build antes, na esteira:
#   npm run build -w @aiportal/web        → web/dist
#   npm run build -w @aiportal/relay      → relay/dist/server.cjs
# Depois, da RAIZ do repo:  docker build -f relay/Dockerfile -t portal-relay .
FROM node:22-alpine
WORKDIR /app
COPY relay/dist/server.cjs ./server.cjs
COPY web/dist ./web
ENV NODE_ENV=production
ENV PORT=8787
# a UI é servida pelo próprio relay; deixe vazio para servir só o /relay/* (UI no S3)
ENV RELAY_STATIC_DIR=/app/web
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/relay/health || exit 1
CMD ["node", "server.cjs"]
