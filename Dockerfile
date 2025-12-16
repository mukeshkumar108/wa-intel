# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY docs ./docs
RUN npm run build

# --- runtime stage ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# ensure output directory exists for JSONL stores
RUN mkdir -p /app/out
EXPOSE 4000
CMD ["node", "dist/index.js"]
