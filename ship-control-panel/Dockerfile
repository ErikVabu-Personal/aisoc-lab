# Standalone Next.js container for Azure Container Apps

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Next standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# OTEL bootstrap (must be present at runtime because CMD uses `-r ./otel.js`)
COPY --from=builder /app/otel.js ./otel.js

# public/ may be empty. Ensure it exists so COPY won't fail.
RUN mkdir -p ./public
COPY --from=builder /app/public ./public

EXPOSE 3000
ENV PORT=3000

CMD ["node", "-r", "./otel.js", "server.js"]
