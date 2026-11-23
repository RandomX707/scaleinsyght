FROM node:22-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN chown -R node:node /app /pnpm
USER node

FROM runtime AS api
EXPOSE 3000
CMD ["pnpm","--filter","@scaleinsyght/api","start"]

FROM runtime AS worker
EXPOSE 3001
CMD ["pnpm","--filter","@scaleinsyght/worker","start"]

FROM runtime AS web
RUN pnpm --filter @scaleinsyght/web exec vite build
EXPOSE 4173
CMD ["node","scripts/web-static.mjs"]

FROM runtime AS gateway
CMD ["pnpm","gateway:start"]

FROM runtime AS db-tools
CMD ["pnpm","db:setup"]
