FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p temp

ENV NODE_ENV=production

CMD ["node", "overleaf-mcp-server.js"]
