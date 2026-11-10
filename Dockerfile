FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY test/ test/
RUN npm test && npm run build && npm prune --omit=dev

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
LABEL org.opencontainers.image.source="https://github.com/mossquartz731/bookorbit-mcp"
ENV NODE_ENV=production MCP_TRANSPORT=http
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["node", "dist/server.js"]
CMD ["serve"]
