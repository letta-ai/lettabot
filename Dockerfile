FROM node:22-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/main.js"]
