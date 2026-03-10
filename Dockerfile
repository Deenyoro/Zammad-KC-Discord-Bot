FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-alpine
# sharp for image conversion (webp/jpg → png), libreoffice for doc → pdf
RUN apk add --no-cache libreoffice-writer libreoffice-calc libreoffice-impress \
    fontconfig ttf-dejavu \
    && rm -rf /var/cache/apk/*
RUN addgroup -S bot && adduser -S bot -G bot
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
RUN mkdir -p data && chown bot:bot data
USER bot
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3100/healthz || exit 1
CMD ["node", "dist/index.js"]
