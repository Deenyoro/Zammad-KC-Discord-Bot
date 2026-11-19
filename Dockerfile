FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-alpine
# sharp for image conversion (webp/jpg → png), libreoffice for doc → pdf,
# su-exec for the entrypoint to drop root
RUN apk add --no-cache libreoffice-writer libreoffice-calc libreoffice-impress \
    fontconfig ttf-dejavu su-exec \
    && rm -rf /var/cache/apk/*
RUN addgroup -S bot && adduser -S bot -G bot
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
RUN mkdir -p data && chown bot:bot data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# No USER line: the entrypoint starts as root only to fix ownership of the
# bind-mounted data/ and then runs the bot as the unprivileged "bot" user.
# Kubernetes (runAsUser) and `docker run --user` skip that step.
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3100/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
