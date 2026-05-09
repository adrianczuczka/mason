FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm link

ENTRYPOINT ["mason-mcp"]
