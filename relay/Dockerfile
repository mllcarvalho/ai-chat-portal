# Relay do portal hospedado. Build antes (na esteira): `npm run build -w @aiportal/relay`
# gera dist/server.cjs autossuficiente — a imagem não precisa de node_modules.
FROM node:22-alpine
WORKDIR /app
COPY dist/server.cjs ./server.cjs
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/relay/health || exit 1
CMD ["node", "server.cjs"]
