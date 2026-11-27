FROM node:24-alpine AS dependencies
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS runner
WORKDIR /app/backend
ENV NODE_ENV=production PORT=5000 SERVE_FRONTEND=false
COPY --from=dependencies --chown=node:node /app/backend/node_modules ./node_modules
COPY --chown=node:node backend/ ./
# Shared checkout/profile validation; no storefront pages in the API image.
COPY --chown=node:node frontend/js/customer-validation.js /app/frontend/js/customer-validation.js
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:5000/api/health || exit 1
CMD ["node", "server.js"]
