FROM node:20-alpine

RUN npm install -g mason-context@latest

ENTRYPOINT ["mason-mcp"]
