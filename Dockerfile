FROM node:22.22.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.22.0-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["npm","start"]
