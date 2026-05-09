FROM node:20-alpine

RUN npm install -g mason-context@0.3.6

ENTRYPOINT ["mason-mcp"]
